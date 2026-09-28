/**
 * `ToolExecutor`: runs the tool calls an LLM response requests, handling risk
 * classification, approval gating, concurrency limits, timeouts, and interruption.
 */

import { Cause, Effect, Either, Exit, Fiber, Option } from "effect";
import { RunParkRequested } from "@/core/agent/run/park-signal";
import { resolveCommandRisk, shouldClassifyExecuteCommand } from "@/core/agent/tools/command-risk";
import { MAX_CONCURRENT_TOOLS, TOOL_TIMEOUT_MS } from "@/core/constants/agent";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import {
  PresentationServiceTag,
  type PresentationService,
  type StreamingRenderer,
} from "@/core/interfaces/presentation";
import {
  ToolRegistryTag,
  type Tool,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import {
  GenerationInterruptedError,
  type ToolNotFoundError,
  ToolTimeoutError,
} from "@/core/types/errors";
import type { MemoryExposure } from "@/core/types/message";
import type { DisplayConfig } from "@/core/types/output";
import {
  type ApprovalOutcome,
  isApprovalRequiredResult,
  shouldAutoApprove,
  type ApprovalRequiredResult,
  type ToolCall,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRiskLevel,
  type UntrustedProvenance,
} from "@/core/types/tools";
import { formatDuration } from "@/core/utils/duration";
import { toError } from "@/core/utils/errors";
import { isRecord } from "@/core/utils/is-record";
import { isCommandCoveredByAllowlist } from "@/core/utils/shell";
import { toolResultForProgress } from "@/core/utils/tool-result-formatter";
import { frameUntrusted } from "@/core/utils/untrusted-content";
import { taintedEgressApprovalMessage, taintedEgressNeedsApproval } from "./egress-taint";
import {
  privateDestinationApprovalMessage,
  privateDestinationNeedsApproval,
  rememberPrivateAddresses,
  unlistedPrivateAddressesFor,
} from "./private-destination";
import type { ToolBatchLedger } from "./tool-batch-ledger";
import {
  emitToolInvocation,
  recordToolError,
  recordToolInvocation,
  telemetryErrorCategory,
  type createAgentRunMetrics,
} from "../metrics/agent-run-metrics";

/**
 * Display metadata for tools whose behavior depends on a configured backend.
 * For web_search, resolves the provider the handler will actually use
 * (per-agent override first, then global config) so the UI can show
 * `web_search(brave)` instead of a bare tool name.
 */
function resolveToolDisplayMetadata(
  name: string,
  context: ToolExecutionContext,
): Effect.Effect<Record<string, unknown> | undefined, never, AgentConfigService> {
  return Effect.gen(function* () {
    if (name !== "web_search") return undefined;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const provider =
      context.parentAgent?.config.webSearchProvider ?? appConfig.web_search?.provider;
    return { provider: provider ?? "builtin" };
  });
}

/** A tool call's arguments as the tool receives them, or why they cannot be used. */
type ParsedToolArguments =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

/**
 * Read a tool call's arguments. A call the provider flagged invalid, arguments that are not
 * JSON, and JSON that is not an object are all refused with the reason, so the model is told
 * its call was malformed instead of the tool running on defaults.
 */
export function parseToolCallArguments(toolCall: ToolCall): ParsedToolArguments {
  if (toolCall.invalidReason !== undefined) {
    return { ok: false, error: `Invalid tool call: ${toolCall.invalidReason}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch (parseError) {
    return {
      ok: false,
      error: `Invalid JSON in tool arguments: ${toError(parseError).message}`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Invalid tool arguments: expected a JSON object." };
  }
  return { ok: true, args: parsed };
}

/**
 * The conversation the command-risk classifier may read as evidence of what the
 * user asked for, or `undefined` when the command has to stand on its own.
 *
 * Conversation turns are evidence only when the person the approval protects
 * wrote them. On a bridge (no prompt possible) they come from whoever is
 * messaging the bot. In a sub-agent the "user" turn is the task the parent
 * model wrote, so a parent that has been talked into something could write the
 * justification for its child's command.
 */
function classifierEvidence(
  context: ToolExecutionContext,
  canPrompt: boolean,
): ToolExecutionContext["conversationMessages"] {
  if (!canPrompt || (context.subagentDepth ?? 0) > 0) {
    return undefined;
  }
  return context.conversationMessages;
}

type ToolGateMetadata = Pick<
  Tool<never>,
  "riskLevel" | "resolveRiskLevel" | "approvalExecuteToolName" | "egress"
>;

/** How much of a call's arguments a plain tool's approval prompt quotes. */
const PLAIN_TOOL_APPROVAL_ARGS_CHARS = 600;

/**
 * The level a plain (non-approval) tool's call is gated on, or `undefined` when the call
 * needs no gate: an approval tool is gated by the request it returns, and a plain
 * `read-only` call runs under every policy.
 */
function plainToolGateRisk(
  tool: ToolGateMetadata | undefined,
  args: Record<string, unknown>,
): ToolRiskLevel | undefined {
  if (tool === undefined || tool.approvalExecuteToolName !== undefined) {
    return undefined;
  }
  const riskLevel = tool.resolveRiskLevel?.(args) ?? tool.riskLevel;
  return riskLevel === "read-only" ? undefined : riskLevel;
}

/**
 * The approval request the executor raises on behalf of a gated plain tool. Approving it
 * runs the tool itself with the same arguments.
 */
function plainToolApprovalRequest(
  name: string,
  args: Record<string, unknown>,
  riskLevel: ToolRiskLevel,
): ApprovalRequiredResult {
  const quoted = JSON.stringify(args);
  const clipped =
    quoted.length > PLAIN_TOOL_APPROVAL_ARGS_CHARS
      ? `${quoted.slice(0, PLAIN_TOOL_APPROVAL_ARGS_CHARS - 1)}…`
      : quoted;
  return {
    approvalRequired: true,
    message: `Run ${name} (${riskLevel}) with ${clipped}`,
    executeToolName: name,
    executeArgs: args,
  };
}

/**
 * Whether an approval request a tool returned is one that tool may make: its registered
 * `approvalExecuteToolName` names the execute half the request asks to run. Any other tool
 * output shaped like a request (an MCP server's reply, a fetched JSON document) is data.
 */
function isRequestBoundToTool(
  tool: ToolGateMetadata | undefined,
  request: ApprovalRequiredResult,
): boolean {
  return (
    tool?.approvalExecuteToolName !== undefined &&
    tool.approvalExecuteToolName === request.executeToolName
  );
}

/** Use the run-scoped policy resolver when present, preserving the built-in classifier fallback. */
function resolveEligibleCommandRisk(
  command: string,
  context: ToolExecutionContext,
  conversationMessages: ToolExecutionContext["conversationMessages"],
  runMetrics: ReturnType<typeof createAgentRunMetrics>,
): Effect.Effect<ToolRiskLevel, never, LLMService | LoggerService> {
  if (context.resolveCommandRisk !== undefined) {
    return context.resolveCommandRisk(command, conversationMessages);
  }
  if (context.parentAgent === undefined) return Effect.succeed("high-risk");
  return resolveCommandRisk(command, context.parentAgent, conversationMessages, runMetrics);
}

/**
 * Service for executing tools
 */
export class ToolExecutor {
  /**
   * Execute a tool by name with the provided arguments
   * Applies a timeout to prevent indefinite hanging
   */
  static executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    overrideTimeoutMs?: number,
  ): Effect.Effect<
    ToolExecutionResult,
    ToolNotFoundError | Error,
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements
  > {
    return Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      const logger = yield* LoggerServiceTag;

      // Registry resolves against every tool in the process — reachability is decided here.
      // Fail closed unless the run set an allowlist or the caller opted into unrestricted.
      if (context.unrestrictedTools !== true) {
        if (context.effectiveToolNames === undefined) {
          yield* logger.warn("Blocked tool call with no effective tool set configured", {
            agentId: context.agentId,
          });
          return {
            success: false,
            result: null,
            error: `Tool '${name}' cannot run: no effective tool set was configured for this call.`,
          } satisfies ToolExecutionResult;
        }
        if (!context.effectiveToolNames.has(name)) {
          yield* logger.warn("Blocked tool call outside this run's tool set", {
            agentId: context.agentId,
          });
          return {
            success: false,
            result: null,
            error: `Tool '${name}' is not available to this agent. Use one of the tools you were given.`,
          } satisfies ToolExecutionResult;
        }
      }

      // Use caller-provided timeout, or look up per-tool timeout, or fall back to default.
      // Always resolve meta so the hidden-tool gate below cannot be skipped when a timeout
      // override is passed.
      let timeoutMs = overrideTimeoutMs;
      const toolMeta = yield* registry
        .getTool(name)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
      if (timeoutMs === undefined) {
        timeoutMs = toolMeta?.timeoutMs;
        // Long-running tools (e.g. user interaction) with no explicit timeout run indefinitely
        if (timeoutMs === undefined && !toolMeta?.longRunning) {
          timeoutMs = TOOL_TIMEOUT_MS;
        }
      }

      // Hidden execute halves skip approval if called directly. Only the post-approval
      // path sets allowHiddenExecute when invoking the name the propose half returned.
      if (toolMeta?.hidden === true && context.allowHiddenExecute !== true) {
        yield* logger.warn("Blocked direct call to hidden execute tool", {
          agentId: context.agentId,
        });
        return {
          success: false,
          result: null,
          error: `Tool '${name}' cannot be called directly. Call the tool that proposes it and the approved operation will run.`,
        } satisfies ToolExecutionResult;
      }

      const execution = registry.executeTool(name, args, context);
      const result = yield* timeoutMs !== undefined
        ? execution.pipe(
            Effect.timeoutFail({
              duration: timeoutMs,
              onTimeout: () => new ToolTimeoutError({ toolName: name, timeoutMs }),
            }),
            Effect.catchTag("ToolTimeoutError", (timeout) =>
              Effect.gen(function* () {
                yield* logger.warn("Tool execution timed out", {
                  toolName: toolMeta?.name ?? "unknown",
                  timeoutMs: timeout.timeoutMs,
                });
                return {
                  success: false,
                  result: null,
                  error: `Tool '${timeout.toolName}' timed out after ${formatDuration(timeout.timeoutMs)} and was stopped.`,
                } satisfies ToolExecutionResult;
              }),
            ),
          )
        : execution;

      return result;
    });
  }

  /**
   * Put a tool without an approval half to a person when it is egress and either the run is
   * tainted (see `egress-taint.ts`) or its URL reaches private addresses nothing allows yet (see
   * `private-destination.ts`). Both reasons, when both apply, are one approval.
   *
   * Undefined when the call needs no one. Otherwise the outcome: an answer given before a park
   * when resuming, or whatever the presentation returns (a prompt where somebody can answer, a
   * decline where nobody can; parking was already decided for the whole batch before anything
   * ran). A person's approval of private addresses also adds them to `network.allowPrivateHosts`.
   */
  static confirmEgress(
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    toolMeta: { readonly egress: boolean; readonly riskLevel: ToolRiskLevel },
    context: ToolExecutionContext,
    renderer: StreamingRenderer | null,
    privateAddresses: readonly string[],
  ): Effect.Effect<
    ApprovalOutcome | undefined,
    never,
    PresentationService | LoggerService | AgentConfigService
  > {
    return Effect.gen(function* () {
      const taintGated = () =>
        context.egressTaint !== undefined &&
        plainToolNeedsTaintApproval(name, args, toolMeta.egress, context);
      const privateGated = () =>
        privateDestinationNeedsApproval(
          privateAddresses,
          context.getAutoApprovePolicy?.(),
          isToolNameAutoApproved(name, context.autoApprovedTools),
        );
      if (!taintGated() && !privateGated()) {
        return undefined;
      }
      const presentationService = yield* PresentationServiceTag;
      const logger = yield* LoggerServiceTag;
      const message = [
        ...(taintGated() && context.egressTaint !== undefined
          ? [taintedEgressApprovalMessage(name, args, context.egressTaint)]
          : []),
        ...(privateGated()
          ? [privateDestinationApprovalMessage(name, args, privateAddresses)]
          : []),
      ].join("\n\n");
      const policy = context.getAutoApprovePolicy?.();

      yield* logger.info("Egress tool needs approval", {
        toolCallId,
        autoApprovePolicy: policy,
        untrustedContent: taintGated(),
        privateDestination: privateGated(),
      });
      context.onToolEvent?.({ kind: "approval-required", toolName: name, toolCallId });
      if (renderer) {
        yield* renderer.handleEvent({
          type: "approval_required",
          toolCallId,
          toolName: name,
          message,
          riskLevel: toolMeta.riskLevel,
          ...(policy !== undefined ? { autoApprovePolicy: String(policy) } : {}),
        });
      }

      const outcome =
        context.resolvedApprovals?.get(toolCallId) ??
        (yield* presentationService.requestApproval({
          toolCallId,
          toolName: name,
          message,
          executeToolName: name,
          executeArgs: args,
          isAutoApproved: () => !taintGated() && !privateGated(),
        }));

      if (renderer) {
        yield* renderer.handleEvent({
          type: "approval_resolved",
          toolCallId,
          toolName: name,
          approved: outcome.approved,
          auto: false,
        });
      }
      if (outcome.approved && outcome.alwaysApproveTool && context.onAutoApproveTool) {
        context.onAutoApproveTool(outcome.alwaysApproveTool);
      }
      if (outcome.approved && privateGated()) {
        yield* rememberPrivateAddresses(privateAddresses);
      }
      return outcome;
    });
  }

  /**
   * Execute a single tool call and return result
   */
  static executeToolCall(
    toolCall: ToolCall,
    context: ToolExecutionContext,
    displayConfig: DisplayConfig,
    renderer: StreamingRenderer | null,
    runMetrics: ReturnType<typeof createAgentRunMetrics>,
    agentId: string,
    conversationId: string,
    toolsRequiringApproval: ReadonlySet<string>,
    parkable = false,
    /** Command-risk verdicts the batch's pre-park pass already paid for, by tool call id. */
    preclassifiedRisk?: ReadonlyMap<string, ToolRiskLevel>,
    /** Told when the call's side effect begins, so a stopped batch can say what ran. */
    ledger?: ToolBatchLedger,
  ): Effect.Effect<
    ToolCallOutcome,
    Error,
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | ToolRequirements
    | PresentationService
    | LLMService
  > {
    return Effect.gen(function* () {
      const presentationService = yield* PresentationServiceTag;
      const logger = yield* LoggerServiceTag;

      if (toolCall.type !== "function") {
        return { toolCallId: toolCall.id, result: null, success: false, name: "unknown" };
      }

      const { name } = toolCall.function;
      recordToolInvocation(runMetrics, name);
      const toolStartTime = Date.now();
      let telemetryToolName = "unknown";

      try {
        const parsedArguments = parseToolCallArguments(toolCall);
        if (!parsedArguments.ok) {
          throw new Error(parsedArguments.error);
        }
        const args = parsedArguments.args;

        yield* logger.logToolCall(name, args);

        // Look up tool metadata for UI hints
        const registry = yield* ToolRegistryTag;
        const toolMeta = yield* registry
          .getTool(name)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        telemetryToolName = toolMeta?.name ?? "unknown";
        const isLongRunning = toolMeta?.longRunning === true;

        // Hidden tools are refused in executeTool unless allowHiddenExecute is set.
        // Bail before UI start events when the model named one directly.
        if (toolMeta?.hidden === true && context.allowHiddenExecute !== true) {
          const errorMessage = `Tool '${name}' cannot be called directly. Call the tool that proposes it and the approved operation will run.`;
          recordToolError(runMetrics, name, new Error(errorMessage));
          yield* logger.warn("Blocked direct call to hidden execute tool", {
            agentId,
            conversationId,
            toolCallId: toolCall.id,
          });
          return {
            toolCallId: toolCall.id,
            result: { error: errorMessage },
            success: false,
            name,
          };
        }

        // Emit tool execution start - skip for approval tools to avoid interleaving with
        // approval UI when multiple tools run in parallel (approval wrapper returns
        // immediately; the real "Executing tool" is emitted after user approval)
        const plainGateRisk = plainToolGateRisk(toolMeta, args);
        const isApprovalTool = toolsRequiringApproval.has(name) || plainGateRisk !== undefined;
        // The counterpart to "Tool execution succeeded"/"failed" below. Both carry the
        // tool call id, so a start with no completion — a row the live band keeps
        // spinning forever — is one grep apart from being named.
        yield* logger.debug("Tool execution starting", {
          agentId,
          conversationId,
          toolCallId: toolCall.id,
        });
        // Reported regardless of display config: a caller watching over HTTP is not a
        // terminal that can be told to be quiet, and this is its only view of a long turn.
        context.onToolEvent?.({ kind: "tool-started", toolName: name, toolCallId: toolCall.id });
        if (displayConfig.showToolExecution && !isApprovalTool) {
          // Build metadata for specific tools (e.g., web_search provider)
          const metadata = yield* resolveToolDisplayMetadata(name, context);
          if (renderer) {
            yield* renderer.handleEvent({
              type: "tool_execution_start",
              toolName: name,
              toolCallId: toolCall.id,
              arguments: args,
              ...(metadata ? { metadata } : {}),
              ...(isLongRunning ? { longRunning: true } : {}),
            });
          } else {
            const message = yield* presentationService.formatToolExecutionStart(
              name,
              args,
              metadata ? { metadata } : undefined,
            );
            yield* presentationService.writeBlankLine();
            yield* presentationService.writeOutput(message);
          }
        }

        // A gated plain tool does not run yet: the executor raises the approval request
        // for it, and the approval path applies the egress taint. An ungated plain tool
        // still stops for tainted egress here. Everything else runs, and an approval
        // tool's run is its proposal.
        let result: ToolExecutionResult;
        let pendingApproval: ApprovalRequiredResult | undefined;
        if (plainGateRisk !== undefined) {
          pendingApproval = plainToolApprovalRequest(name, args, plainGateRisk);
          result = { success: true, result: pendingApproval };
        } else {
          const privateAddresses =
            toolMeta !== undefined && toolMeta.approvalExecuteToolName === undefined
              ? yield* unlistedPrivateAddressesFor(toolMeta.egress, args, context)
              : [];
          const taintVerdict =
            toolMeta !== undefined && toolMeta.approvalExecuteToolName === undefined
              ? yield* ToolExecutor.confirmEgress(
                  toolCall.id,
                  name,
                  args,
                  toolMeta,
                  context,
                  renderer,
                  privateAddresses,
                )
              : undefined;
          // An approval tool's own call only builds the request; its side effect starts
          // after approval, below.
          if (!isApprovalTool && (taintVerdict === undefined || taintVerdict.approved)) {
            ledger?.markStarted(toolCall.id);
          }
          // Pass the pre-fetched timeout to avoid a redundant getTool lookup.
          result =
            taintVerdict !== undefined && !taintVerdict.approved
              ? rejectedToolResult(taintVerdict.userMessage)
              : yield* ToolExecutor.executeTool(
                  name,
                  args,
                  {
                    ...context,
                    toolCallId: toolCall.id,
                    ...(privateAddresses.length > 0
                      ? { approvedPrivateAddresses: privateAddresses }
                      : {}),
                  },
                  toolMeta?.timeoutMs,
                );
          if (isApprovalRequiredResult(result.result)) {
            if (isRequestBoundToTool(toolMeta, result.result)) {
              pendingApproval = result.result;
            } else {
              yield* logger.warn("Refused an approval request the tool is not registered to make", {
                toolCallId: toolCall.id,
              });
              result = {
                success: false,
                result: null,
                error: `${name} returned an approval request for ${result.result.executeToolName}, which it is not registered to propose. Nothing was run.`,
              };
            }
          }
        }
        let toolDuration = Date.now() - toolStartTime;
        let finalToolName = name;
        let classifiedRisk: ToolRiskLevel | undefined;

        // An approval request: show the approval UI (or auto-approve), then run the
        // execute half.
        if (pendingApproval !== undefined) {
          const approvalResult = pendingApproval;
          const registry = yield* ToolRegistryTag;

          // Get the tool's risk level to check against auto-approve policy
          const toolInfo = yield* registry
            .getTool(name)
            .pipe(Effect.catchAll(() => Effect.succeed({ riskLevel: "high-risk" as const })));
          let riskLevel = plainGateRisk ?? toolInfo.riskLevel;

          const getCurrentPolicy = () => context.getAutoApprovePolicy?.();
          const autoApprovePolicy = getCurrentPolicy();
          const allowlisted =
            isToolNameAutoApproved(name, context.autoApprovedTools) ||
            isCommandAutoApproved(name, approvalResult.executeArgs, context.autoApprovedCommands);

          // Decides prompt-or-park; it does not change which calls auto-approve.
          const canPrompt = presentationService.canPromptForApproval?.() === true;

          const commandArg = approvalResult.executeArgs["command"];
          const command = typeof commandArg === "string" ? commandArg : undefined;

          const alreadyClassified = preclassifiedRisk?.get(toolCall.id);
          if (alreadyClassified !== undefined) {
            classifiedRisk = alreadyClassified;
            riskLevel = alreadyClassified;
          } else if (
            name === "execute_command" &&
            shouldClassifyExecuteCommand(riskLevel, autoApprovePolicy, allowlisted) &&
            context.parentAgent &&
            command !== undefined
          ) {
            if (displayConfig.showToolExecution) {
              if (renderer) {
                yield* renderer.handleEvent({
                  type: "command_risk_classifying",
                  toolCallId: toolCall.id,
                  toolName: name,
                  command,
                });
              } else {
                yield* presentationService.writeOutput(`Classifying ${name}…\n`);
              }
            }
            classifiedRisk = yield* resolveEligibleCommandRisk(
              command,
              context,
              classifierEvidence(context, canPrompt),
              runMetrics,
            );
            riskLevel = classifiedRisk;
          }

          const egress = "egress" in toolInfo && toolInfo.egress;
          const taintGated = () =>
            taintedEgressNeedsApproval({
              toolName: name,
              egress,
              args: approvalResult.executeArgs,
              policy: getCurrentPolicy(),
              taint: context.egressTaint,
              messages: context.conversationMessages,
            });
          const privateAddresses = yield* unlistedPrivateAddressesFor(
            egress,
            approvalResult.executeArgs,
            context,
          );
          const privateGated = () =>
            privateDestinationNeedsApproval(privateAddresses, getCurrentPolicy(), false);

          // Check if auto-approve policy allows this tool, per-tool session allowlist,
          // or per-command prefix allowlist matches
          const checkAutoApproved = () =>
            (shouldAutoApprove(riskLevel, getCurrentPolicy()) &&
              !taintGated() &&
              !privateGated()) ||
            isToolNameAutoApproved(name, context.autoApprovedTools) ||
            isCommandAutoApproved(name, approvalResult.executeArgs, context.autoApprovedCommands);

          // A picker-style request is never auto-approved, under any policy including
          // yolo: there is nothing to approve until somebody picked a row. The
          // companion-bound path skips approval inside the tool itself instead.
          const hasSelectionOptions = (approvalResult.options?.length ?? 0) > 0;
          const isAutoApproved = !hasSelectionOptions && checkAutoApproved();

          if (classifiedRisk !== undefined && displayConfig.showToolExecution) {
            if (renderer) {
              yield* renderer.handleEvent({
                type: "command_risk_classified",
                toolCallId: toolCall.id,
                toolName: name,
                command: command ?? "",
                riskLevel: classifiedRisk,
                autoApproved: isAutoApproved,
              });
            } else {
              const outcome = isAutoApproved ? " · auto-approved" : "";
              yield* presentationService.writeOutput(
                `${name} classified as ${classifiedRisk}${outcome}\n`,
              );
            }
          }

          if (renderer) {
            yield* renderer.handleEvent({
              type: "approval_required",
              toolCallId: toolCall.id,
              toolName: name,
              message: approvalResult.message,
              ...(approvalResult.previewDiff ? { previewDiff: approvalResult.previewDiff } : {}),
              ...(hasSelectionOptions ? { options: approvalResult.options } : {}),
              riskLevel,
              ...(autoApprovePolicy !== undefined
                ? { autoApprovePolicy: String(autoApprovePolicy) }
                : {}),
            });
          }

          if (isAutoApproved) {
            yield* logger.info("Tool auto-approved by policy", {
              riskLevel,
              autoApprovePolicy,
            });
          } else {
            yield* logger.debug("Tool requires approval, showing approval prompt", {
              riskLevel,
              autoApprovePolicy,
            });
          }

          // Show approval prompt to user (unless auto-approved).
          // Pass an isAutoApproved callback so the approval queue can re-check
          // at dequeue time — a parallel tool's "always approve" may have
          // updated the shared allowlists while this request was queued.
          // Also re-checks current policy for real-time mode switches.
          const approvalMessage = [
            approvalResult.message,
            ...(!isAutoApproved && context.egressTaint !== undefined && taintGated()
              ? [
                  taintedEgressApprovalMessage(
                    name,
                    approvalResult.executeArgs,
                    context.egressTaint,
                  ),
                ]
              : []),
            ...(!isAutoApproved && privateGated()
              ? [
                  privateDestinationApprovalMessage(
                    name,
                    approvalResult.executeArgs,
                    privateAddresses,
                  ),
                ]
              : []),
          ].join("\n\n");
          const approvalRequest = {
            toolCallId: toolCall.id,
            toolName: name,
            message: approvalMessage,
            executeToolName: approvalResult.executeToolName,
            executeArgs: approvalResult.executeArgs,
            ...(approvalResult.previewDiff ? { previewDiff: approvalResult.previewDiff } : {}),
            ...(hasSelectionOptions ? { options: approvalResult.options } : {}),
            isAutoApproved: checkAutoApproved,
          };

          // A resumed run already carries the answer a person gave in another process.
          const alreadyAnswered = context.resolvedApprovals?.get(toolCall.id);

          // Parking unwinds the whole run, so it has to happen before anything executes.
          // `parkable` is false for a multi-call batch precisely because siblings may
          // already have run, and replaying them on resume would repeat their effects.
          const shouldPark =
            parkable &&
            !isAutoApproved &&
            alreadyAnswered === undefined &&
            presentationService.canPromptForApproval?.() !== true;

          if (shouldPark) {
            yield* logger.info("Parking run: approval needed and nobody can answer in-process", {
              toolCallId: toolCall.id,
            });
            return yield* Effect.fail(
              new RunParkRequested({
                pending: { kind: "tool-approval", request: approvalRequest },
              }),
            );
          }

          const outcome = isAutoApproved
            ? { approved: true as const }
            : (alreadyAnswered ?? (yield* presentationService.requestApproval(approvalRequest)));

          if (renderer) {
            yield* renderer.handleEvent({
              type: "approval_resolved",
              toolCallId: toolCall.id,
              toolName: name,
              approved: outcome.approved,
              auto: isAutoApproved,
            });
          }

          if (outcome.approved) {
            // Handle "always approve this command" choice (execute_command only)
            if (outcome.alwaysApproveCommand && context.onAutoApproveCommand) {
              yield* context.onAutoApproveCommand(outcome.alwaysApproveCommand);
              yield* logger.info("User chose to always approve command", {
                toolCallId: toolCall.id,
              });
            }

            // Handle "always approve this tool" choice (any approval tool)
            if (outcome.alwaysApproveTool && context.onAutoApproveTool) {
              context.onAutoApproveTool(outcome.alwaysApproveTool);
              yield* logger.info("User chose to always approve tool");
            }

            if (!isAutoApproved) {
              yield* logger.info("User approved tool execution", { toolCallId: toolCall.id });
              if (privateGated()) {
                yield* rememberPrivateAddresses(privateAddresses);
              }
            }

            // Execute the execution tool. A picker-style outcome carries the row the
            // human chose; it rides to the execution tool under a reserved key the
            // model never writes and cannot spoof.
            const executeArgs =
              "selectedOptionId" in outcome && typeof outcome.selectedOptionId === "string"
                ? { ...approvalResult.executeArgs, _selectedOptionId: outcome.selectedOptionId }
                : approvalResult.executeArgs;
            const executeStartTime = Date.now();

            // Emit execution start for the follow-up tool
            if (displayConfig.showToolExecution) {
              const executeMetadata = yield* resolveToolDisplayMetadata(
                approvalResult.executeToolName,
                context,
              );
              if (renderer) {
                yield* renderer.handleEvent({
                  type: "tool_execution_start",
                  toolName: name,
                  toolCallId: toolCall.id,
                  arguments: executeArgs,
                  ...(executeMetadata ? { metadata: executeMetadata } : {}),
                });
              } else {
                const message = yield* presentationService.formatToolExecutionStart(
                  name,
                  executeArgs,
                  executeMetadata ? { metadata: executeMetadata } : undefined,
                );
                yield* presentationService.writeBlankLine();
                yield* presentationService.writeOutput(message);
              }
            }

            // Execute the actual tool. allowHiddenExecute is required: executeTool refuses
            // hidden tools unless the post-approval path opts in.
            ledger?.markStarted(toolCall.id);
            result = yield* ToolExecutor.executeTool(approvalResult.executeToolName, executeArgs, {
              ...context,
              allowHiddenExecute: true,
              ...(privateAddresses.length > 0
                ? { approvedPrivateAddresses: privateAddresses }
                : {}),
            });
            toolDuration = Date.now() - executeStartTime;
            finalToolName = approvalResult.executeToolName;
            const executeToolMeta = yield* registry
              .getTool(finalToolName)
              .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            telemetryToolName = executeToolMeta?.name ?? "unknown";

            yield* logger.debug("Execution tool completed after approval", {
              success: result.success,
              durationMs: toolDuration,
              autoApproved: isAutoApproved,
            });
          } else {
            yield* logger.info("User rejected tool execution", {
              toolCallId: toolCall.id,
            });

            result = rejectedToolResult(
              (outcome as { approved: false; userMessage?: string }).userMessage,
            );
          }
        }

        const resultString = JSON.stringify(result.result);

        // Log tool result details for debugging
        yield* logger.debug("Tool execution succeeded", {
          agentId,
          conversationId,
          toolCallId: toolCall.id,
          durationMs: toolDuration,
          success: result.success,
          resultSize: resultString.length,
        });

        // Emit tool execution complete
        if (displayConfig.showToolExecution) {
          if (renderer) {
            yield* renderer.handleEvent({
              type: "tool_execution_complete",
              toolCallId: toolCall.id,
              result: resultString,
              durationMs: toolDuration,
              success: result.success,
              ...(result.success ? {} : { error: result.error ?? "Tool execution failed" }),
              ...(classifiedRisk !== undefined ? { classifiedRisk } : {}),
            });
          } else {
            if (result.success) {
              const summary = presentationService.formatToolResult(finalToolName, resultString);
              const message = yield* presentationService.formatToolExecutionComplete(
                summary,
                toolDuration,
              );
              yield* presentationService.writeOutput(message);
            } else {
              const errorMsg = result.error || "Tool execution failed";
              const message = yield* presentationService.formatToolExecutionError(
                errorMsg,
                toolDuration,
              );
              yield* presentationService.writeOutput(message);
            }
          }
        }

        // Now that this tool has finished and its result has been rendered,
        // release the next queued approval prompt — so approvals and results
        // never interleave (approve → run → result → approve). No-op unless an
        // approval is waiting.
        yield* presentationService.signalToolExecutionStarted();

        yield* emitToolInvocation(runMetrics, {
          toolCallId: toolCall.id,
          toolName: telemetryToolName,
          success: result.success,
          durationMs: toolDuration,
          ...(result.success ? {} : { error: result.error ?? "Tool execution failed" }),
        });

        const finalResult = result.success
          ? result.result
          : { error: result.error ?? "Tool execution failed", result: result.result };
        if (result.untrusted?.kind === "external") {
          context.egressTaint?.mark(result.untrusted.source);
        }
        return {
          toolCallId: toolCall.id,
          result: finalResult,
          success: result.success,
          name: finalToolName,
          ...(result.success && result.memoryExposure !== undefined
            ? { memoryExposure: result.memoryExposure }
            : {}),
          ...(result.untrusted !== undefined ? { untrusted: result.untrusted } : {}),
        };
      } catch (error) {
        const toolDuration = Date.now() - toolStartTime;
        const errorMessage = toError(error).message;

        // Emit error
        if (displayConfig.showToolExecution) {
          if (renderer) {
            yield* renderer.handleEvent({
              type: "tool_execution_complete",
              toolCallId: toolCall.id,
              result: `Error: ${errorMessage}`,
              durationMs: toolDuration,
              success: false,
              error: errorMessage,
            });
          } else {
            const message = yield* presentationService.formatToolExecutionError(
              errorMessage,
              toolDuration,
            );
            yield* presentationService.writeOutput(message);
          }
        }

        recordToolError(runMetrics, name, error);
        yield* emitToolInvocation(runMetrics, {
          toolCallId: toolCall.id,
          toolName: telemetryToolName,
          success: false,
          durationMs: toolDuration,
          error,
        });
        yield* logger.error("Tool execution failed", {
          agentId,
          conversationId,
          toolCallId: toolCall.id,
          errorType: telemetryErrorCategory(error),
        });

        // Release the next queued approval after this failure too, so a failed
        // tool doesn't stall the approval queue.
        yield* presentationService.signalToolExecutionStarted();

        return {
          toolCallId: toolCall.id,
          result: { error: errorMessage },
          success: false,
          name,
        };
      }
    });
  }

  /**
   * Execute all tool calls and return results
   */
  static executeToolCalls(
    toolCalls: readonly ToolCall[],
    context: ToolExecutionContext,
    displayConfig: DisplayConfig,
    renderer: StreamingRenderer | null,
    runMetrics: ReturnType<typeof createAgentRunMetrics>,
    agentId: string,
    conversationId: string,
    agentName: string,
    interruptSignal?: Effect.Effect<void, never>,
    backgroundSignal?: Effect.Effect<void, never>,
    onDetachedToolComplete?: (summary: string) => void,
    /** Records what each call did, for a batch that is stopped before it finishes. */
    ledger?: ToolBatchLedger,
  ): Effect.Effect<
    ToolCallOutcome[],
    Error,
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | ToolRequirements
    | PresentationService
    | LLMService
  > {
    return Effect.gen(function* () {
      const presentationService = yield* PresentationServiceTag;
      const logger = yield* LoggerServiceTag;
      const registry = yield* ToolRegistryTag;
      const toolNames = toolCalls.map((tc) => tc.function.name);

      // Fetch tool information to determine which require approval.
      // Do this in parallel so large tool batches don't pay a sequential pre-pass.
      const uniqueToolNames = Array.from(new Set(toolNames));
      const toolResults = yield* Effect.all(
        uniqueToolNames.map((toolName) => Effect.either(registry.getTool(toolName))),
        { concurrency: MAX_CONCURRENT_TOOLS },
      );
      const approvalToolNameSet = new Set<string>();
      const toolMetaByName = new Map<string, ToolGateMetadata>();
      for (let i = 0; i < uniqueToolNames.length; i++) {
        const uniqueToolName = uniqueToolNames[i];
        const toolResult = toolResults[i];
        if (uniqueToolName && toolResult && Either.isRight(toolResult)) {
          toolMetaByName.set(uniqueToolName, toolResult.right);
          if (toolResult.right.approvalExecuteToolName) {
            approvalToolNameSet.add(uniqueToolName);
          }
        }
      }
      const toolsRequiringApproval = toolNames.filter((toolName) =>
        approvalToolNameSet.has(toolName),
      );

      // Show tools detected
      if (displayConfig.showToolExecution) {
        if (renderer) {
          yield* renderer.handleEvent({
            type: "tools_detected",
            toolNames,
            toolsRequiringApproval,
            agentName,
          });
        } else {
          const message = yield* presentationService.formatToolsDetected(
            agentName,
            toolNames,
            toolsRequiringApproval,
          );
          yield* presentationService.writeOutput(message);
        }
      }

      yield* logger.debug("Agent requested tools", {
        agentId,
        conversationId,
        toolCount: toolCalls.length,
      });

      const approvalSet = new Set(toolsRequiringApproval);

      /**
       * Park the whole batch before any of it runs, if anything in it needs a person.
       *
       * Parking used to be allowed only for a lone tool call, because resuming replays the
       * batch and a sibling that had already executed would run twice. The consequence was
       * that a batch went to a presentation which cannot ask anybody — and quiet mode
       * declines — so an agent that asked to run two commands at once had both silently
       * refused, with the run reporting success. That is what a webhook caller saw as
       * nothing happening and no approval to answer.
       *
       * The hazard is narrower than "a batch". An approval tool's own call has no side
       * effect: it returns the request and the effect happens in the execute tool afterwards.
       * So parking is safe as long as it happens before anything executes, which is what
       * deciding here rather than inside each fiber buys. Every round either parks having
       * run nothing, or has every approval in hand and runs the batch once.
       *
       * Verdicts reached here are handed to the per-call path via `preclassifiedRisk`, which
       * would otherwise classify the same command a second time inside its own fiber.
       */
      const preclassifiedRisk = new Map<string, ToolRiskLevel>();
      const parkTheBatch = Effect.gen(function* () {
        if (context.parkWhenUnattended !== true) return undefined;
        if (presentationService.canPromptForApproval?.() === true) return undefined;

        const needsAnswering: ToolCall[] = [];
        let firstRequest: Parameters<typeof presentationService.requestApproval>[0] | undefined;
        for (const toolCall of toolCalls) {
          const name = toolCall.function.name;
          if (context.resolvedApprovals?.get(toolCall.id) !== undefined) continue;

          const parsedArguments = parseToolCallArguments(toolCall);
          // Malformed arguments are the per-call path's error to report, not this one's.
          if (!parsedArguments.ok) {
            continue;
          }
          const args = parsedArguments.args;

          const toolMeta = toolMetaByName.get(name);
          const plainGateRisk = plainToolGateRisk(toolMeta, args);
          let request: ApprovalRequiredResult;
          if (plainGateRisk !== undefined) {
            request = plainToolApprovalRequest(name, args, plainGateRisk);
          } else {
            if (!approvalSet.has(name)) {
              if (toolMeta === undefined) {
                continue;
              }
              const taintGated =
                context.egressTaint !== undefined &&
                plainToolNeedsTaintApproval(name, args, toolMeta.egress, context);
              const privateAddresses = yield* unlistedPrivateAddressesFor(
                toolMeta.egress,
                args,
                context,
              );
              const privateGated = privateDestinationNeedsApproval(
                privateAddresses,
                context.getAutoApprovePolicy?.(),
                isToolNameAutoApproved(name, context.autoApprovedTools),
              );
              if (!taintGated && !privateGated) {
                continue;
              }
              needsAnswering.push(toolCall);
              if (needsAnswering.length === 1) {
                firstRequest = {
                  toolCallId: toolCall.id,
                  toolName: name,
                  message: [
                    ...(taintGated && context.egressTaint !== undefined
                      ? [taintedEgressApprovalMessage(name, args, context.egressTaint)]
                      : []),
                    ...(privateGated
                      ? [privateDestinationApprovalMessage(name, args, privateAddresses)]
                      : []),
                  ].join("\n\n"),
                  executeToolName: name,
                  executeArgs: args,
                  isAutoApproved: () => false,
                };
              }
              continue;
            }
            // Side-effect free for an approval tool: this is the call that builds the request.
            const probe = yield* ToolExecutor.executeTool(name, args, {
              ...context,
              toolCallId: toolCall.id,
            }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            if (probe === undefined || !isApprovalRequiredResult(probe.result)) continue;
            if (!isRequestBoundToTool(toolMeta, probe.result)) continue;
            request = probe.result;
          }

          const policy = context.getAutoApprovePolicy?.();
          const allowlisted =
            isToolNameAutoApproved(name, context.autoApprovedTools) ||
            isCommandAutoApproved(name, request.executeArgs, context.autoApprovedCommands);

          // Without classifying, `execute_command` stays `unknown` and parks even `git
          // status` — while the per-call path, which does classify, would let it through.
          let riskLevel = plainGateRisk ?? toolMeta?.riskLevel ?? "high-risk";
          const commandArg = request.executeArgs["command"];
          const command = typeof commandArg === "string" ? commandArg : undefined;
          if (
            name === "execute_command" &&
            shouldClassifyExecuteCommand(riskLevel, policy, allowlisted) &&
            context.parentAgent &&
            command !== undefined
          ) {
            // Nobody can be prompted here, so the command stands on its own.
            riskLevel = yield* resolveEligibleCommandRisk(command, context, undefined, runMetrics);
            preclassifiedRisk.set(toolCall.id, riskLevel);
          }

          const taintGated = taintedEgressNeedsApproval({
            toolName: name,
            egress: toolMeta?.egress === true,
            args: request.executeArgs,
            policy,
            taint: context.egressTaint,
            messages: context.conversationMessages,
          });
          const privateAddresses = yield* unlistedPrivateAddressesFor(
            toolMeta?.egress === true,
            request.executeArgs,
            context,
          );
          const privateGated = privateDestinationNeedsApproval(privateAddresses, policy, false);
          if (
            (shouldAutoApprove(riskLevel, policy) && !taintGated && !privateGated) ||
            allowlisted
          ) {
            continue;
          }

          needsAnswering.push(toolCall);
          if (needsAnswering.length === 1) {
            firstRequest = {
              toolCallId: toolCall.id,
              toolName: name,
              message: privateGated
                ? `${request.message}\n\n${privateDestinationApprovalMessage(name, request.executeArgs, privateAddresses)}`
                : request.message,
              executeToolName: request.executeToolName,
              executeArgs: request.executeArgs,
              isAutoApproved: () => false,
            };
          }
        }

        if (needsAnswering.length === 0 || firstRequest === undefined) return undefined;

        // One at a time, however many the turn needs. Each park carries the answers already
        // given, so the next round sees them and stops on the next unanswered one rather
        // than going round in a circle. Nothing has run at this point on any round, which
        // is what makes replaying the batch on resume safe.
        yield* logger.info("Parking run: approval needed and nobody can answer in-process", {
          toolCallId: firstRequest.toolCallId,
          batchSize: toolCalls.length,
          stillToAnswer: needsAnswering.length,
        });
        context.onToolEvent?.({
          kind: "approval-required",
          toolName: firstRequest.toolName,
          toolCallId: firstRequest.toolCallId,
        });
        const pendingTurnAnswers = Object.fromEntries(context.resolvedApprovals ?? []);
        return new RunParkRequested({
          pending: { kind: "tool-approval", request: firstRequest },
          ...(Object.keys(pendingTurnAnswers).length > 0 ? { pendingTurnAnswers } : {}),
        });
      });

      const park = yield* parkTheBatch;
      if (park !== undefined) return yield* Effect.fail(park);

      const settleToolBatch = (
        toolFibers: ReadonlyArray<Fiber.RuntimeFiber<ToolCallOutcome, Error>>,
      ) =>
        Effect.gen(function* () {
          const awaitResults = Effect.all(
            toolFibers.map((fiber) => Fiber.join(fiber)),
            { concurrency: "unbounded" },
          );

          // Both signals are optional and mutually exclusive per race: whichever fires first
          // (if either does) decides how this batch resolves. Racing them against each other
          // first, rather than nesting two `Effect.race` calls against `awaitResults`, keeps
          // the outcome type to one flat union instead of an awkward `let`-reassigned one.
          const interruptOrBackground = interruptSignal?.pipe(
            Effect.as({ type: "interrupt" as const }),
          );
          const backgroundOrInterrupt = backgroundSignal?.pipe(
            Effect.as({ type: "background" as const }),
          );
          const signalEffect =
            interruptOrBackground && backgroundOrInterrupt
              ? Effect.race(interruptOrBackground, backgroundOrInterrupt)
              : (interruptOrBackground ?? backgroundOrInterrupt);

          if (!signalEffect) {
            return yield* awaitResults;
          }

          // `raceFirst`: a failed batch fails now instead of waiting on a signal that may
          // never come.
          const resultsOrSignal = yield* Effect.raceFirst(
            awaitResults.pipe(Effect.map((results) => ({ type: "results" as const, results }))),
            signalEffect,
          );

          if (resultsOrSignal.type === "interrupt") {
            // Settle the UI before waiting on fiber interrupt, so a slow finalizer
            // cannot leave the 30s "still running" timer armed across the next turn.
            if (renderer && displayConfig.showToolExecution) {
              for (let index = 0; index < toolFibers.length; index++) {
                const fiber = toolFibers[index];
                const toolCall = toolCalls[index];
                if (fiber === undefined || toolCall === undefined || toolCall.type !== "function") {
                  continue;
                }
                const poll = yield* Fiber.poll(fiber);
                if (
                  Option.isNone(poll) ||
                  (Option.isSome(poll) && Exit.isInterrupted(poll.value))
                ) {
                  yield* renderer.handleEvent({
                    type: "tool_execution_complete",
                    toolCallId: toolCall.id,
                    result: "Interrupted by user",
                    durationMs: 0,
                    success: false,
                    error: "Interrupted by user",
                  });
                }
              }
            }
            yield* Effect.all(
              toolFibers.map((fiber) => Fiber.interrupt(fiber)),
              { concurrency: "unbounded" },
            );
            return yield* Effect.fail(
              new GenerationInterruptedError({ reason: "Tool execution interrupted by user" }),
            );
          }

          if (resultsOrSignal.type === "background") {
            return yield* detachInFlightToolCalls(
              toolFibers,
              toolCalls,
              renderer,
              displayConfig,
              onDetachedToolComplete,
            );
          }

          return resultsOrSignal.results;
        });

      /**
       * Tool calls run as daemon fibers so a call detached into the background (Ctrl+B)
       * outlives this batch; a plain `Effect.fork` child is interrupted as soon as its
       * parent scope closes. Being daemons, they are not interrupted with the run on their
       * own, so every fiber is interrupted explicitly when this batch is interrupted
       * (`--timeout`, SIGTERM, a run deadline, a parent's race). `Fiber.interrupt` waits for
       * each fiber's finalizers, which is what kills a running shell command's process group.
       * Forking happens with interruption masked so no fiber can start without being tracked.
       */
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const toolFibers = yield* Effect.all(
            toolCalls.map((toolCall) =>
              Effect.forkDaemon(
                Effect.interruptible(
                  // Tapped once here rather than at each of the several places a call can
                  // finish, so a new return path cannot quietly stop reporting.
                  ToolExecutor.executeToolCall(
                    toolCall,
                    context,
                    displayConfig,
                    renderer,
                    runMetrics,
                    agentId,
                    conversationId,
                    approvalSet,
                    false,
                    preclassifiedRisk,
                    ledger,
                  ).pipe(
                    Effect.tap((outcome) =>
                      Effect.sync(() => {
                        ledger?.markFinished(outcome);
                        const returned = toolResultForProgress(outcome.result);
                        context.onToolEvent?.({
                          kind: "tool-finished",
                          toolName: outcome.name,
                          toolCallId: outcome.toolCallId,
                          ok: outcome.success,
                          ...(returned !== undefined
                            ? {
                                result: returned.text,
                                ...(returned.truncated ? { resultTruncated: true } : {}),
                              }
                            : {}),
                        });
                      }),
                    ),
                  ),
                ),
              ),
            ),
            { concurrency: MAX_CONCURRENT_TOOLS },
          );

          return yield* restore(settleToolBatch(toolFibers)).pipe(
            Effect.onInterrupt(() => Fiber.interruptAll(toolFibers)),
          );
        }),
      );
    });
  }
}

/** One executed tool call as the agent loop receives it. */
export interface ToolCallOutcome {
  readonly toolCallId: string;
  readonly result: unknown;
  readonly success: boolean;
  readonly name: string;
  /** Carried from the tool's own result so the loop never re-derives it by tool name. */
  readonly memoryExposure?: MemoryExposure;
  /** Carried from the tool's own result; the loop frames the result it appends. */
  readonly untrusted?: UntrustedProvenance;
}

/**
 * Detach every tool call still in flight so it keeps running to completion as a daemon
 * fiber (outliving this tool phase, and this turn) instead of being interrupted, and
 * return a "running in the background" placeholder for each right away so the loop can
 * continue. A call that already finished naturally in the small window before this fired
 * is reported with its real result instead of a placeholder.
 *
 * `onDetachedToolComplete` fires later, once, per detached call, with a plain-text
 * summary — there is no live turn to splice a proper tool-result message into by then,
 * so the caller's job is just to get that summary in front of the model somehow (the CLI
 * wiring queues it the same way a message typed mid-run is queued).
 */
function detachInFlightToolCalls(
  toolFibers: ReadonlyArray<Fiber.RuntimeFiber<ToolCallOutcome, Error>>,
  toolCalls: readonly ToolCall[],
  renderer: StreamingRenderer | null,
  displayConfig: DisplayConfig,
  onDetachedToolComplete: ((summary: string) => void) | undefined,
): Effect.Effect<ToolCallOutcome[], never> {
  return Effect.gen(function* () {
    const outcomes: ToolCallOutcome[] = [];

    for (let index = 0; index < toolFibers.length; index++) {
      const fiber = toolFibers[index];
      const toolCall = toolCalls[index];
      if (fiber === undefined || toolCall === undefined) continue;
      const name = toolCall.type === "function" ? toolCall.function.name : "unknown";

      const poll = yield* Fiber.poll(fiber);
      if (Option.isSome(poll) && Exit.isSuccess(poll.value)) {
        // Already finished naturally in the gap between the signal firing and this
        // running — its real result, not a placeholder.
        outcomes.push(poll.value.value);
        continue;
      }

      outcomes.push({
        toolCallId: toolCall.id,
        result: {
          backgrounded: true,
          message: "Running in the background — you'll be told when it finishes.",
        },
        success: true,
        name,
      });

      if (renderer && displayConfig.showToolExecution) {
        yield* renderer.handleEvent({
          type: "tool_execution_complete",
          toolCallId: toolCall.id,
          result: "Running in the background",
          durationMs: 0,
          success: true,
          summary: "→ backgrounded",
        });
      }

      yield* Effect.forkDaemon(
        Fiber.await(fiber).pipe(
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              const summary = Exit.isSuccess(exit)
                ? summarizeDetachedOutcome(exit.value)
                : `Background task \`${name}\` failed to finish: ${Cause.pretty(exit.cause)}`;
              onDetachedToolComplete?.(summary);
            }),
          ),
        ),
      );
    }

    return outcomes;
  });
}

/** Plain-text summary of a detached tool call's real outcome, for `onDetachedToolComplete`. */
function summarizeDetachedOutcome(outcome: ToolCallOutcome): string {
  const body = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result);
  const truncated = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  const shown =
    outcome.untrusted === undefined ? truncated : frameUntrusted(truncated, outcome.untrusted);
  return `Background task \`${outcome.name}\` ${outcome.success ? "finished" : "failed"}: ${shown}`;
}

/**
 * Check if a command is auto-approved via the per-command allowlist.
 * Only applies to `execute_command` tools; returns false for all others.
 * Matching is `isCommandCoveredByAllowlist`: a compound command, or one with
 * substitution, redirection or an environment prefix, never matches.
 */
function isCommandAutoApproved(
  toolName: string,
  executeArgs: Record<string, unknown>,
  allowedCommands: readonly string[] | undefined,
): boolean {
  if (!allowedCommands?.length) return false;
  if (toolName !== "execute_command") return false;
  const command = executeArgs["command"];
  if (typeof command !== "string") return false;
  return isCommandCoveredByAllowlist(command, allowedCommands);
}

/**
 * Check if a tool is auto-approved via the per-tool allowlist.
 * Matches the approval tool name (e.g. "edit_file") against the session list.
 */
function isToolNameAutoApproved(
  toolName: string,
  approvedTools: readonly string[] | undefined,
): boolean {
  if (!approvedTools?.length) return false;
  return approvedTools.includes(toolName);
}

/** What a declined call returns to the model, with the person's own words when they gave some. */
function rejectedToolResult(userMessage: string | undefined): ToolExecutionResult {
  return {
    success: false,
    result: {
      rejected: true,
      message:
        userMessage?.trim() ||
        "User rejected the operation. Please acknowledge this and ask if they'd like to try something different.",
    },
    error: "User rejected the operation",
  };
}

/**
 * Whether a tool without an approval half must be put to a person before it runs, because the
 * run is tainted and it is egress. An explicit per-tool allowlist entry still approves it.
 */
function plainToolNeedsTaintApproval(
  name: string,
  args: Record<string, unknown>,
  egress: boolean,
  context: ToolExecutionContext,
): boolean {
  return (
    !isToolNameAutoApproved(name, context.autoApprovedTools) &&
    taintedEgressNeedsApproval({
      toolName: name,
      egress,
      args,
      policy: context.getAutoApprovePolicy?.(),
      taint: context.egressTaint,
      messages: context.conversationMessages,
    })
  );
}
