/**
 * Tool-calling types shared across the agent runner: definitions/results,
 * approval requests and outcomes, auto-approve policy, and the execution
 * context passed into every tool.
 */
import type { Effect } from "effect";
import type z from "zod";
import type { SubagentSupervisor } from "@/core/agent/subagents/supervisor";
import type { BrowserSessions } from "@/core/agent/tools/browser/session";
import type { ComputerSessions } from "@/core/agent/tools/computer/session";
import type { LLMService } from "@/core/interfaces/llm";
import type { LoggerService } from "@/core/interfaces/logger";
import type { TelemetryTraceParent } from "@/core/interfaces/telemetry";
import type { ToolRiskLevel } from "@/core/interfaces/tool-registry";
import type { UserSecretStore } from "@/core/secrets/user-secrets";
import type { Agent } from "@/core/types/agent";
import type { GeneratedArtifact } from "@/core/types/artifact";
import type { AttachmentKind, MessageAttachment } from "@/core/types/attachment";
import type { HttpApprovalPolicy } from "@/core/types/config";
import type { ChatMessage, MemoryExposure, MemorySource } from "@/core/types/message";
import type {
  ClassifyPageInput,
  ClassifyPageOutcome,
  RouteSnapshotInput,
  RouteSnapshotOutcome,
} from "@/core/types/plugin";
import type { StreamEvent } from "@/core/types/streaming";

/** A secret typed for a parked ask_user_secret call, or the person declining to type one. */
export type ResolvedUserSecret =
  { readonly kind: "provided"; readonly value: string } | { readonly kind: "declined" };

// Re-export ToolRiskLevel from tool-registry interface
export type { ToolRiskLevel } from "@/core/interfaces/tool-registry";

/**
 * Auto-approve policy for workflow execution.
 *
 * - `false` or undefined: Safe mode — **interactive sessions only** auto-approve
 *   read-only and low-risk and prompt for the rest. Where nobody can be asked,
 *   an absent policy still approves nothing, which is what makes leaving it
 *   unset a safe default for a webhook or a cron.
 * - `true` or `"high-risk"`: Auto-approve all tools (including high-risk)
 * - `"low-risk"`: Auto-approve read-only and low-risk tools, prompt for high-risk
 * - `"read-only"`: Auto-approve only read-only tools, prompt for low-risk and high-risk
 * - `unknown` risk resolves through the command classifier first; an unresolved
 *   `unknown` is never auto-approved except under `true` / `"high-risk"`
 */
export type AutoApprovePolicy = boolean | ApprovalPolicyLevel;

/** The named approval tiers, lowest authority first; every surface validates against this. */
export const APPROVAL_POLICY_LEVELS = ["read-only", "low-risk", "high-risk"] as const;
export type ApprovalPolicyLevel = (typeof APPROVAL_POLICY_LEVELS)[number];

export function isApprovalPolicyLevel(value: string): value is ApprovalPolicyLevel {
  return (APPROVAL_POLICY_LEVELS as readonly string[]).includes(value);
}

/**
 * Check if a tool's risk level should be auto-approved given a policy.
 *
 * `canPrompt` says whether this surface can actually put the decision in front
 * of a human. Safe mode is the one tier whose meaning depends on it: skipping a
 * prompt is only a kindness where a prompt was the alternative. Callers that
 * cannot answer the question leave it out and get the conservative reading.
 */
/**
 * Most of a tool result a progress event will carry.
 *
 * Not a formatting decision — how much of a result to *show* belongs to the listener, and
 * everything under this ceiling arrives whole. This is the transport saying that a tool
 * which returns an entire PDF should not push it through a fire-and-forget status POST on
 * every call. A result over the line is cut here and flagged `resultTruncated`, so a
 * listener that wants the rest knows to wait for the run's real answer rather than treating
 * a clipped document as the whole one.
 */
export const MAX_PROGRESS_RESULT_CHARS = 8_000;

/** What a run reports about itself while it is still going. */
export interface ToolProgressEvent {
  readonly kind: "tool-started" | "tool-finished" | "approval-required";
  readonly toolName: string;
  readonly toolCallId?: string;
  /** Set on "tool-finished": whether the call succeeded. */
  readonly ok?: boolean;
  /**
   * Set on "tool-finished": what the call returned.
   *
   * `ok` alone says a tool ran without saying what it found, which is the difference
   * between "search_web finished" and "search_web — 8 results". Sent unformatted and
   * uncut up to `MAX_PROGRESS_RESULT_CHARS`, because how much of a result to show is the
   * listener's question, not the daemon's: a status line wants a clause, a log pane wants
   * the lot, and a daemon that clipped to one of those would have destroyed the other's
   * answer before it was asked.
   *
   * Only ever sent to the loopback progress URL the caller supplied, so this does not widen
   * where a tool result can travel: it stays on the machine that produced it.
   */
  readonly result?: string;
  /** Set on "tool-finished" when `result` hit the ceiling and is not the whole thing. */
  readonly resultTruncated?: boolean;
}

/**
 * Whether `riskLevel` clears `policy` without anybody being asked. Deliberately independent of
 * whether a person is reachable: being unattended changes what happens to the calls that do not
 * clear (they park instead of prompting), not which ones clear.
 *
 * No policy and `false` clear nothing: every gated call asks, or is declined or parked when
 * nobody can answer.
 */
export function shouldAutoApprove(
  riskLevel: ToolRiskLevel,
  policy: AutoApprovePolicy | undefined,
): boolean {
  if (policy === undefined || policy === false) {
    return false;
  }

  // true or "high-risk" means approve everything
  if (policy === true || policy === "high-risk") return true;

  // "low-risk" approves read-only and low-risk
  if (policy === "low-risk") {
    return riskLevel === "read-only" || riskLevel === "low-risk";
  }

  // "read-only" only approves read-only tools
  if (policy === "read-only") {
    return riskLevel === "read-only";
  }

  return false;
}

/**
 * Tool/Function calling types
 */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: z.ZodTypeAny;
    jsonSchema?: Readonly<Record<string, unknown>>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  /**
   * Google Gemini thought_signature - encrypted representation of model's
   * internal reasoning. Must be preserved when present to maintain context.
   */
  thought_signature?: string;
  /**
   * Why the provider marked this call invalid (arguments that do not parse or do not match the
   * tool's schema, or a tool that does not exist). An invalid call is answered with this error
   * as its tool result and is never executed.
   */
  invalidReason?: string;
}

export interface ToolCallResult {
  toolCallId: string;
  role: "tool";
  name: string;
  content: string;
}

/**
 * Where untrusted text in a tool result came from, as declared by the tool that produced it.
 *
 * `external` is content from off this machine or from another party (web pages, API responses,
 * MCP servers, shell and custom-command output, peers). `local-file` is a file outside the run's
 * working directory: framed because anybody may have written it, but it does not change what the
 * run may send.
 */
export interface UntrustedProvenance {
  readonly kind: "external" | "local-file";
  /** Short, human-readable origin, e.g. `web_fetch https://example.com/post`. */
  readonly source: string;
  /** Replaces the default reminder after the content. */
  readonly reminder?: string;
}

/**
 * Whether a run has read external untrusted content. One object is shared by a run and every
 * sub-agent it spawns, so taint flows both ways across the tree (see `egress-taint.ts`).
 */
export interface EgressTaint {
  readonly isTainted: () => boolean;
  /** The sources that marked the run, oldest first, for approval messages. */
  readonly sources: () => readonly string[];
  readonly mark: (source: string) => void;
}

export interface ToolExecutionResult {
  readonly success: boolean;
  readonly result: unknown;
  readonly error?: string;
  /**
   * Files this call produced, for the runner to surface to whoever is watching.
   *
   * Declared by the producer rather than recognized by tool name downstream, so adding a
   * producer does not mean editing the runner, the JSON envelope and every bridge.
   */
  readonly artifacts?: readonly GeneratedArtifact[];
  /** A memory entry this call showed the model, declared by the producer for the same reason. */
  readonly memoryExposure?: MemoryExposure;
  /**
   * Set when the result carries text from a party other than the user. The agent loop wraps the
   * result in the untrusted envelope, and `external` provenance marks the run's `EgressTaint`.
   */
  readonly untrusted?: UntrustedProvenance;
}

/**
 * One selectable choice in a picker-style approval.
 *
 * Most approvals are yes/no, but some decisions are "which of these" — e.g. which
 * vision-capable model should analyze an image. When a proposal carries `options`,
 * surfaces render a selector instead of approve/deny, and the chosen option's `id`
 * comes back on the outcome. A request with options is never auto-approved: there is
 * nothing to approve until somebody picked.
 */
export interface ApprovalOption {
  /** Stable identifier returned as `selectedOptionId` when this row is chosen. */
  readonly id: string;
  /** Primary label, e.g. the model's display name. */
  readonly label: string;
  /** Secondary line: provider, pricing, anything that helps compare rows. */
  readonly detail?: string;
}

/**
 * Result structure when a tool requires user approval before execution.
 * Returned by approval tools created with `defineApprovalTool`.
 */
export interface ApprovalRequiredResult {
  readonly approvalRequired: true;
  /** Human-readable message explaining what will happen if approved */
  readonly message: string;
  /** The name of the tool to execute after approval */
  readonly executeToolName: string;
  /** The arguments to pass to the execution tool */
  readonly executeArgs: Record<string, unknown>;
  /** Optional full diff preview for file edit operations (expandable with Ctrl+O) */
  readonly previewDiff?: string;
  /**
   * What approving concretely does, with real numbers, in one short line:
   * `214 files, 1.3 GB` or `overwrites 173 lines`. Surfaces show it beside the
   * fields; it never repeats a path or a command the fields already carry.
   */
  readonly impact?: string;
  /**
   * The one string argument a person may rewrite before approving, such as a shell
   * command. The rewritten value runs through the execution tool's own checks.
   */
  readonly editableArg?: string;
  /**
   * When present, the human picks one option instead of approving yes/no.
   * The selected option's id reaches the execution tool via the executor,
   * merged into its args under `_selectedOptionId`.
   */
  readonly options?: readonly ApprovalOption[];
  /**
   * A person answers this request under every auto-approve policy and allowlist; with nobody
   * to ask, the run parks for approval.
   */
  readonly alwaysAsk?: true;
  /**
   * The message the tool result carries when a person declines this request, instead of
   * the generic "you declined" one. Set it when the default text would not say what
   * declined and what happens next.
   */
  readonly rejectionMessage?: string;
}

/**
 * Request structure for approval prompts shown to the user
 */
export interface ApprovalRequest {
  /** Correlates this request with its `tool_call.id`, so an external approver
   * (e.g. the Telegram bridge) can resolve the specific pending approval. */
  readonly toolCallId: string;
  /** The name of the tool requesting approval */
  readonly toolName: string;
  /** Human-readable description of the action */
  readonly message: string;
  /** The execution tool that will be called on approval */
  readonly executeToolName: string;
  /** Arguments that will be passed to the execution tool */
  readonly executeArgs: Record<string, unknown>;
  /** Optional full diff preview for file edit operations (expandable with Ctrl+O) */
  readonly previewDiff?: string;
  /** What approving concretely does, with real numbers. See {@link ApprovalRequiredResult.impact}. */
  readonly impact?: string;
  /** The argument a person may rewrite before approving. See {@link ApprovalRequiredResult.editableArg}. */
  readonly editableArg?: string;
  /**
   * The message the model receives when the person declines, in place of the generic
   * rejection text. See {@link ApprovalRequiredResult.rejectionMessage}.
   */
  readonly rejectionMessage?: string;
  /** The risk class of the call being approved, when the tool declares one. */
  readonly riskLevel?: ToolRiskLevel;
  /**
   * A caution the executor adds on top of the tool's own message, such as the run having
   * read untrusted content before this outbound call. `message` already contains it; a
   * surface that replaces the tool's prose with its own summary shows this instead, so the
   * caution is never lost with the prose.
   */
  readonly warning?: string;
  /**
   * When present, the surface renders a picker (one row per option) instead of an
   * approve/deny card. The chosen row's id returns as `selectedOptionId`.
   */
  readonly options?: readonly ApprovalOption[];
  /**
   * Optional callback to re-check auto-approve status at dequeue time.
   * Used by the approval queue to skip prompts for tools that were
   * auto-approved by a parallel tool's "always approve" choice while
   * waiting in the queue.
   */
  readonly isAutoApproved?: () => boolean;
}

/**
 * Result of a user approval decision.
 * When rejected, the user may optionally provide a message to guide the agent (e.g. "Don't bump version, do X instead").
 */
export type ApprovalOutcome =
  | {
      readonly approved: true;
      readonly alwaysApproveCommand?: string;
      readonly alwaysApproveTool?: string;
      /**
       * For picker-style requests (`ApprovalRequest.options`): which row the human
       * chose. The executor merges this into the execution tool's args under
       * `_selectedOptionId`; absent when the request had no options.
       */
      readonly selectedOptionId?: string;
      /**
       * A person's rewrite of the request's `editableArg`, applied before the call runs.
       * Keyed by argument name; any key other than `editableArg` is ignored.
       */
      readonly editedArgs?: Readonly<Record<string, string>>;
    }
  | { readonly approved: false; readonly userMessage?: string };

/**
 * Type guard to check if a tool result requires approval
 */
export function isApprovalRequiredResult(result: unknown): result is ApprovalRequiredResult {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    r["approvalRequired"] === true &&
    typeof r["message"] === "string" &&
    typeof r["executeToolName"] === "string" &&
    typeof r["executeArgs"] === "object" &&
    r["executeArgs"] !== null
  );
}

/** `eager`: schema sent every turn. `deferred`: only name/summary sent; schema fetched on demand via `search_tools`. */
export type ToolLoadTier = "eager" | "deferred";

export interface ToolCategory {
  readonly id: string;
  readonly displayName: string;
  readonly loadTier: ToolLoadTier;
}

export interface ToolExecutionContext {
  readonly agentId: string;
  /**
   * Private addresses approved for this call only, on top of the global
   * `network.allowPrivateHosts`. Set by the executor after a person or the run's policy approved a
   * call whose URL reaches them.
   */
  readonly approvedPrivateAddresses?: readonly string[];
  /** User messages the model may quote for memory writes; tool output cannot add to this set. */
  readonly memorySources?: readonly MemorySource[];
  /** Trace context inherited by a child agent invoked from this tool. */
  readonly telemetryTraceParent?: TelemetryTraceParent;
  /** Memory scopes available to this run. */
  readonly memoryScopes?: readonly string[];
  readonly conversationId?: string;
  readonly model?: string;
  /**
   * Auto-approve policy getter for this execution context.
   * Returns the current policy, which may change mid-run via Shift+Tab toggle.
   * When set, tools matching the policy will be auto-approved without user interaction.
   */
  readonly getAutoApprovePolicy?: () => AutoApprovePolicy | undefined;
  /**
   * Token usage statistics for context budget awareness.
   * Allows tools like context_info to report on current context usage.
   */
  readonly tokenStats?: {
    readonly currentTokens: number;
    readonly maxTokens: number;
  };
  /**
   * Current conversation messages, injected by executors.
   * Used by tools like summarize_context to access the full conversation.
   */
  readonly conversationMessages?: readonly ChatMessage[];
  /**
   * Resolve the risk of an eligible `execute_command` call. The runner binds
   * this narrow callback to the run-scoped plugin session and Jazz fallback;
   * tools never receive the plugin session or another policy capability.
   */
  readonly resolveCommandRisk?: (
    command: string,
    conversationMessages?: readonly ChatMessage[],
  ) => Effect.Effect<ToolRiskLevel, never, LLMService | LoggerService>;
  /**
   * Advisory page hooks bound to this run's plugin session. Each resolves to an abstention when
   * no plugin answers. What they return can add scrutiny to a page and reorder its snapshot; it
   * cannot lower a risk, skip an approval, or clear taint.
   */
  readonly classifyPage?: (input: ClassifyPageInput) => Effect.Effect<ClassifyPageOutcome>;
  readonly routeSnapshot?: (input: RouteSnapshotInput) => Effect.Effect<RouteSnapshotOutcome>;
  /**
   * The parent agent running this tool execution.
   * Used by tools like spawn_subagent to inherit LLM configuration.
   */
  readonly parentAgent?: Agent;
  /**
   * Approvals already answered out-of-band, keyed by `toolCallId`.
   *
   * Set only when resuming a parked run: the person answered in another process, possibly
   * yesterday, and the executor uses the stored outcome instead of asking again.
   */
  readonly resolvedApprovals?: ReadonlyMap<string, ApprovalOutcome>;
  /** Answers supplied by a human after a run parked on ask_user_question. */
  readonly resolvedUserInputs?: ReadonlyMap<
    string,
    { readonly kind: "answered"; readonly response: string } | { readonly kind: "declined" }
  >;
  /** Selections supplied by a human after a run parked on ask_file_picker. */
  readonly resolvedFilePickers?: ReadonlyMap<
    string,
    { readonly kind: "selected"; readonly path: string } | { readonly kind: "cancelled" }
  >;
  /** Secrets typed after a run parked on ask_user_secret, held in memory only. */
  readonly resolvedUserSecrets?: ReadonlyMap<string, ResolvedUserSecret>;
  /**
   * This run's typed secrets: what `ask_user_secret` holds and what the registry substitutes
   * into a tool that accepts them. Shared with sub-agents by reference.
   */
  readonly userSecrets?: UserSecretStore;
  /**
   * This run's browser, launched by the first browser tool call and closed when the run ends.
   * Shared with sub-agents by reference.
   */
  readonly browserSessions?: BrowserSessions;
  /**
   * This run's computer session, started by the first computer tool call and closed when the run
   * ends. Sub-agents do not get the computer tools, so none shares it.
   */
  readonly computerSessions?: ComputerSessions;
  /** The individual call currently executing. Set on a per-call context copy. */
  readonly toolCallId?: string;
  /**
   * Whether this run has read external untrusted content. Egress tools stop auto-approving
   * below `high-risk` once it is marked. Shared with sub-agents by reference.
   */
  readonly egressTaint?: EgressTaint;
  /** Global policy for http_request and web_fetch; inherited by subagents. */
  readonly httpApproval?: HttpApprovalPolicy;
  /** Exact effective HTTP URL approved for this call, also enforced on redirects. */
  readonly approvedHttpUrl?: string | undefined;
  /**
   * Whether an unanswerable approval should park the run instead of declining it.
   *
   * Declining is right when nobody will ever answer — a cron job with no approval channel
   * should get a refusal it can route around rather than stall. Parking is right when
   * somebody will answer later, just not in this process. The difference is a property of
   * how the run was started, not of the tool, so the runner decides it once.
   */
  readonly parkWhenUnattended?: boolean;
  /**
   * The executor is collecting approval proposals before any call in a batch runs.
   * Tools may validate and describe a request, but must not perform the operation.
   * A tool with standing consent returns no approval request in this phase and executes
   * only on the later ordinary call. Set by the executor, never accepted from tool args.
   */
  readonly approvalPhase?: "preflight";
  /**
   * Told, as it happens, what this run is doing.
   *
   * For a caller that is not in the room: a webhook holds one HTTP request open and returns
   * a finished answer, so anything watching learns nothing until the run ends. A turn that
   * reads a calendar and searches the web is minutes of unexplained silence to the person
   * who asked for it.
   *
   * Deliberately fire-and-forget and deliberately not a service: it is per-run, the run
   * must not fail because somebody stopped listening, and a slow consumer must not hold up
   * a tool call.
   */
  readonly onToolEvent?: (event: ToolProgressEvent) => void;
  /** The sub-agents of the run executing this tool; set by the agent loop for every run. */
  readonly subagents?: SubagentSupervisor;
  /** Iteration budget for a sub-agent spawned here — its own, not the parent's remainder. */
  readonly maxSubagentIterations?: number;
  /**
   * How many sub-agent levels sit above the run executing this tool. 0 at the
   * top level; `spawn_subagent` increments it and refuses past the limit.
   */
  readonly subagentDepth?: number;
  /** Nesting limit for this run, resolved once by the runner so a whole tree agrees. */
  readonly maxSubagentDepth?: number;
  /**
   * Callback to replace conversation messages with compacted versions.
   * Used by summarize_context to actually update the executor's message array.
   */
  readonly compactConversation?: (compacted: readonly ChatMessage[]) => void;
  /**
   * Whether this run may write durable memory when `summarize_context` compacts, set
   * beside `compactConversation` by the loop that knows the run's persistence and
   * sub-agent state. Absent means no: the gate is never inherited, so a caller that
   * cannot compute it must not extract.
   */
  readonly allowMemoryExtraction?: boolean;
  /**
   * Every tool name this run may execute: resolved toolset plus aliases and hidden
   * execute halves. The executor refuses anything outside it before hitting the registry.
   * `spawn_subagent` hands the same set down as the child's allowlist.
   *
   * Required for agent runs. Omitting it without `unrestrictedTools` fails closed.
   */
  readonly effectiveToolNames?: ReadonlySet<string>;
  /**
   * Explicit escape hatch for one-shot callers outside an agent run. Without this (or
   * `effectiveToolNames`), `executeTool` refuses rather than treating a missing set as
   * allow-all.
   */
  readonly unrestrictedTools?: boolean;
  /**
   * Set only by the post-approval path when invoking a gated pair's hidden execute half.
   * Hidden tools are refused in `executeTool` unless this is true.
   */
  readonly allowHiddenExecute?: boolean;
  /** Names of this run's `deferred`-tier tools `search_tools` may look up. */
  readonly deferredToolNames?: readonly string[];
  /** Called by `search_tools` to make fetched schemas callable for the rest of this run — mirrors `compactConversation`. */
  readonly unlockDeferredTools?: (definitions: readonly ToolDefinition[]) => void;
  /**
   * Attach a media file (image/pdf/audio/video) to the current turn so the model actually
   * receives its contents on the next request.
   *
   * Needed because tool results are text-only: `read_file` on a screenshot can describe the
   * file but cannot put pixels into a `role: "tool"` message. The executor collects whatever
   * tools register here and emits it as a following user message, which every provider accepts
   * as a carrier for file parts.
   *
   * Undefined when the executor has no way to extend the message list (one-shot tool calls,
   * some test harnesses); tools must fall back to describing the file in text.
   */
  readonly attachMedia?: (attachment: MessageAttachment) => void;
  /**
   * Attachment modalities the active model accepts, from its models.dev capabilities.
   *
   * Tools check this before calling `attachMedia` so they can fail loudly rather than send an
   * image to a text-only model — which is a provider error, not a degraded answer.
   */
  readonly supportedAttachmentKinds?: readonly AttachmentKind[];
  /**
   * Whether the active model is served from this machine.
   *
   * Relaxes attachment size limits, which are otherwise copied from the strictest remote API and
   * would reject a large local file for a reason that does not apply to localhost.
   */
  readonly attachmentsAreLocal?: boolean;
  /**
   * Record the USD cost of a nested run (e.g. a sub-agent spawned via
   * spawn_subagent) against the parent run. The parent's finalized costUSD
   * adds this so aggregated pricing reflects all sub-agent spend, not just
   * the orchestrator's own tokens.
   */
  readonly recordChildCost?: (costUSD: number) => void;
  /**
   * Flag that a nested run spent tokens whose pricing was unavailable, so the
   * parent's aggregated costUSD understates real spend and its envelope must
   * report the cost as incomplete.
   */
  readonly recordChildCostUnknown?: () => void;
  /**
   * Record the spend of a model run a tool starts for the run's own upkeep (the
   * `summarize_context` summary) against the run, whatever way that run ended.
   */
  readonly recordSideSpend?: (spend: {
    readonly costUSD: number | undefined;
    readonly costIncomplete: boolean;
  }) => void;
  /**
   * What is left of the running agent's own budgets at the moment of the call. A sub-agent
   * spawned here runs under these, so delegating work can never outlast or outspend the
   * parent. Absent fields are uncapped.
   */
  readonly remainingRunBudget?: () => RemainingRunBudget;
  /**
   * Commands that are always auto-approved for execute_command tool.
   * Each entry is a prefix — a command is approved if it starts with any entry.
   */
  readonly autoApprovedCommands?: readonly string[];
  /**
   * Callback invoked when the user chooses "always approve" for a specific command.
   * The chat service uses this to add the command to the auto-approved list and
   * persist the approval for cross-session promotion.
   */
  readonly onAutoApproveCommand?: (command: string) => Effect.Effect<void>;
  /**
   * Tool names that are always auto-approved for this session.
   * When a tool name appears in this list, it will be auto-approved without prompting.
   */
  readonly autoApprovedTools?: readonly string[];
  /**
   * Callback invoked when the user chooses "always approve" for a specific tool.
   * The chat service uses this to add the tool to the auto-approved list.
   */
  readonly onAutoApproveTool?: (toolName: string) => void;
  /**
   * Emit a live stream event from within a tool — e.g. spawn_subagent emitting
   * subagent_start/complete, or any long-running tool reporting progress.
   * Wired to the executor's streaming renderer when one exists; undefined in
   * non-streaming contexts. Lets tools surface live progress to `--events`
   * consumers without holding a renderer reference themselves.
   */
  readonly emitEvent?: (event: StreamEvent) => Effect.Effect<void, never>;
  /**
   * IANA timezone (e.g. "Europe/Paris") for this run, threaded from the CLI's
   * `--timezone` flag or a surface-specific caller (e.g. the Telegram bridge
   * passing a per-chat zone). Not LLM-facing — tools that need "now" in the
   * caller's local time (e.g. add_reminder) read this directly rather than
   * asking the model to supply a timezone string. Defaults to "UTC" when unset.
   */
  readonly timezone?: string;
  readonly [key: string]: unknown;
}

/** A run's unspent budgets, as handed to a sub-agent it spawns. */
export interface RemainingRunBudget {
  /** Wall-clock milliseconds before the run's `maxDurationMs` deadline. */
  readonly maxDurationMs?: number;
  /** USD left under the run's `maxCostUSD`, counting sub-agent and side spend. */
  readonly maxCostUSD?: number;
  /** Tokens left under the run's `maxTokens`. */
  readonly maxTokens?: number;
}

/** What became of one call in a tool batch that was stopped before it finished. */
export type ToolCallStatus = "completed" | "interrupted" | "not-started";

/** One call of a stopped batch, as the response and `jazz run --json` report it. */
export interface StoppedToolCall {
  readonly id: string;
  readonly name: string;
  readonly status: ToolCallStatus;
}
