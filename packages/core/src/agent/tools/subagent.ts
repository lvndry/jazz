/**
 * `spawn_subagent` and `summarize_context`: delegate a self-contained task to
 * a child agent (with its own persona, model, and iteration/depth budget) and
 * compress the current conversation's context, respectively.
 */

import { Cause, Duration, Effect } from "effect";
import { z } from "zod";
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_SUBAGENT_ITERATIONS,
} from "@/core/constants/agent";
import { isZeroCostLocalModel } from "@/core/constants/local-providers";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";
import type { ConversationMessages } from "@/core/types/message";
import type {
  EgressTaint,
  UntrustedProvenance,
  RemainingRunBudget,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@/core/types/tools";
import { generateConversationId } from "@/core/utils/conversation-id";
import { toError } from "@/core/utils/errors";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from "@/core/utils/tool-result-formatter";
import { AgentRunner } from "../agent-runner";
import { defineTool, makeZodValidator } from "./base-tool";
import { childRunAuthority } from "./child-run-authority";
import { resolveEffectiveContextWindow } from "../context/effective-context-window";
import { Summarizer, type RecursiveRunner } from "../context/summarizer";
import type { RunSpendReport } from "../metrics/agent-run-metrics";
import { judgeAnswer } from "../run/answer-outcome";
import { combinedProvenance, fitSubagentResults } from "../subagents/results";
import { MAX_LIVE_SUBAGENTS, type SubagentHooks } from "../subagents/supervisor";
import type { AgentResponse } from "../types";

// ─── Constants ───────────────────────────────────────────────────────

/** Sub-agent execution timeout: 30 minutes */
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Monotonic counter for unique sub-agent IDs within this process */
let subagentCounter = 0;

/**
 * Which limit stopped a sub-agent before its final answer, read from the
 * response's flags. `undefined` when it finished on its own.
 */
function subagentStopReason(
  response: Pick<
    AgentResponse,
    "iterationLimited" | "costCapped" | "tokenCapped" | "durationCapped"
  >,
): string | undefined {
  if (response.iterationLimited === true) {
    return "iteration limit";
  }
  if (response.costCapped === true) {
    return "cost cap";
  }
  if (response.tokenCapped === true) {
    return "token cap";
  }
  if (response.durationCapped === true) {
    return "time budget";
  }
  return undefined;
}

/**
 * The parent's taint as a child run sees it: shared state, plus a record of whether the child
 * itself read external content, so its answer can be delivered as external content too.
 */
function childEgressTaint(parent: EgressTaint): {
  readonly taint: EgressTaint;
  readonly childReadExternal: () => boolean;
} {
  let readExternal = false;
  return {
    taint: {
      isTainted: parent.isTainted,
      sources: parent.sources,
      mark: (source) => {
        readExternal = true;
        parent.mark(source);
      },
    },
    childReadExternal: () => readExternal,
  };
}

/**
 * The child was told it is a one-shot run with nobody to ask, so a bare user turn
 * mid-task reads like a new task. Framing it as guidance on the current one keeps
 * the child working instead of starting over or stopping to answer it.
 */
function frameSteeringMessage(message: string): string {
  return `[MESSAGE FROM THE USER WHILE YOU WORK]\nTake this into account and continue the task:\n\n${message}`;
}

/**
 * The parent agent's words to a running child. Labelled as the parent's so the child neither
 * starts over nor gives them the weight of the user's own instructions.
 */
function frameParentMessage(message: string): string {
  return `[MESSAGE FROM THE PARENT AGENT WHILE YOU WORK]\nTake this into account and continue the task:\n\n${message}`;
}

// ─── Sub-Agent Tool ──────────────────────────────────────────────────

const spawnSubagentSchema = z.object({
  task: z
    .string()
    .describe(
      "Self-contained brief: every fact, path, constraint and the exact output shape the child needs.",
    ),
  name: z
    .string()
    .optional()
    .describe("Short role label shown in the sub-agent panel, e.g. 'Curriculum coach'."),
  persona: z
    .enum(["default", "coder", "researcher"])
    .optional()
    .default("default")
    .describe("coder for code and git, researcher for read-only investigation, default otherwise."),
  reasoning: z
    .enum(["disable", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Omit to inherit yours. Raise for hard analysis, lower for mechanical work."),
  resultSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "JSON Schema the child's result must validate against; you get its summary plus the structured result.",
    ),
  resultName: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Label for the structured result in prompts and errors."),
});

type SpawnSubagentArgs = z.infer<typeof spawnSubagentSchema>;

type StructuredSubagentResult = {
  readonly summary: string;
  readonly structuredResult: unknown;
  readonly child: {
    readonly id: string;
    readonly durationMs: number;
    readonly costUSD?: number;
    readonly costKnown: boolean;
  };
};

type StructuredResultValidation =
  | { readonly ok: true; readonly value: StructuredSubagentResult }
  | { readonly ok: false; readonly errors: readonly string[] };

const MAX_RESULT_SCHEMA_BYTES = 32 * 1024;
const MAX_STRUCTURED_RESULT_BYTES = 128 * 1024;

function describeJsonSchemaError(error: unknown): string {
  return toError(error).message;
}

function validateResultSchema(resultSchema: Record<string, unknown>): readonly string[] {
  const errors: string[] = [];
  const serialized = JSON.stringify(resultSchema);
  if (serialized.length > MAX_RESULT_SCHEMA_BYTES) {
    errors.push(`resultSchema must be at most ${MAX_RESULT_SCHEMA_BYTES} bytes`);
  }
  if (resultSchema["type"] !== "object") {
    errors.push('resultSchema must declare a root type of "object"');
  }
  if ("$ref" in resultSchema) {
    errors.push("resultSchema must not use a root $ref");
  }
  try {
    z.fromJSONSchema(resultSchema);
  } catch (error) {
    errors.push(`resultSchema is not supported: ${describeJsonSchemaError(error)}`);
  }
  return errors;
}

function structuredCompletionInstructions(
  resultSchema: Record<string, unknown>,
  resultName: string | undefined,
): string {
  const label = resultName ?? "structured result";
  return `\n\nSTRUCTURED COMPLETION REQUIRED\nReturn ONLY one valid JSON object, with no markdown fence or surrounding prose:\n{\n  "summary": "A concise plain-text summary for the parent",\n  "result": <${label} matching this JSON Schema>\n}\n\nThe result must validate against this JSON Schema:\n${JSON.stringify(resultSchema)}\n`;
}

function validateStructuredResult(
  content: string,
  resultSchema: Record<string, unknown>,
  child: StructuredSubagentResult["child"],
): StructuredResultValidation {
  if (Buffer.byteLength(content, "utf8") > MAX_STRUCTURED_RESULT_BYTES) {
    return {
      ok: false,
      errors: [`Structured child output must be at most ${MAX_STRUCTURED_RESULT_BYTES} bytes`],
    };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch {
    return {
      ok: false,
      errors: ["Child did not return a valid JSON structured-result envelope"],
    };
  }

  const parsedEnvelope = z
    .object({ summary: z.string().min(1), result: z.unknown() })
    .strict()
    .safeParse(envelope);
  if (!parsedEnvelope.success) {
    return {
      ok: false,
      errors: parsedEnvelope.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }

  let resultValidator: z.ZodType;
  try {
    resultValidator = z.fromJSONSchema(resultSchema);
  } catch (error) {
    return {
      ok: false,
      errors: [`resultSchema is not supported: ${describeJsonSchemaError(error)}`],
    };
  }

  const parsedResult = resultValidator.safeParse(parsedEnvelope.data.result);
  if (!parsedResult.success) {
    return {
      ok: false,
      errors: parsedResult.error.issues.map((issue) => {
        const path = issue.path.join("result.");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }

  return {
    ok: true,
    value: {
      summary: parsedEnvelope.data.summary,
      structuredResult: parsedResult.data,
      child,
    },
  };
}

/** What `runSubagent` needs from the handler that validated the spawn. */
interface SubagentRun {
  readonly parentAgent: Agent;
  readonly currentDepth: number;
  readonly remainingBudget: RemainingRunBudget;
  readonly subagentLabel: string;
  /** The parent run's handle on this child, for steering and live spend. */
  readonly hooks?: SubagentHooks;
}

/**
 * Run one child to its end and turn its answer into the result `wait_subagents` returns.
 */
function runSubagent(args: SpawnSubagentArgs, context: ToolExecutionContext, run: SubagentRun) {
  const { parentAgent, currentDepth, remainingBudget, subagentLabel, hooks } = run;
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const presentation = yield* PresentationServiceTag;
    yield* logger.info("Spawning sub-agent", {
      task: args.task.substring(0, 200),
      persona: args.persona,
      parentAgentId: parentAgent.id,
    });

    const taskPreview = args.task.length > 80 ? `...${args.task.slice(-77)}` : args.task;
    const startedAt = Date.now();

    const regionId = yield* presentation.openEphemeralRegion("subagent", subagentLabel, {
      agentRun: {
        task: args.task,
        acceptsMessages: presentation.takeEphemeralRegionMessage !== undefined,
      },
    });
    yield* presentation.appendEphemeralRegion(regionId, `Task: ${taskPreview}`);

    // Create an ephemeral sub-agent with the parent's LLM config but a specific persona
    const subAgent: Agent = {
      id: `subagent-${++subagentCounter}-${Date.now()}`,
      name: subagentLabel,
      description: `Ephemeral sub-agent spawned for: ${args.task.substring(0, 100)}`,
      config: {
        ...parentAgent.config,
        persona: args.persona ?? "default",
        ...(args.reasoning
          ? {
              llm: { ...parentAgent.config.llm, reasoning: args.reasoning },
            }
          : {}),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const wrappedTask = `[SUB-AGENT TASK]
You are a sub-agent performing a delegated task for a parent agent. This is a ONE-SHOT task.

Rules:
- Complete the task and produce a answer
- Do NOT ask follow-up questions or wait for user input
- The user or the parent agent may send you guidance while you work; when a message arrives, fold it into the task and keep going
- Do NOT continue searching indefinitely — gather enough information, then synthesise and respond
- If the task is ambiguous, state your assumptions briefly and proceed
- If you cannot complete the task fully, return what you found and explain why
- Stay within the scope of the task — do not take unrequested side actions
- Be concise; the parent agent needs the output, not background narration
- Your response will be returned directly to the parent agent

TASK:
${args.task}${args.resultSchema ? structuredCompletionInstructions(args.resultSchema, args.resultName) : ""}`;

    if (context.emitEvent) {
      yield* context.emitEvent({
        type: "subagent_start",
        task: taskPreview,
        agentName: subagentLabel,
      });
    }

    const childTaint =
      context.egressTaint === undefined ? undefined : childEgressTaint(context.egressTaint);
    const externalProvenance = (): { untrusted?: UntrustedProvenance } =>
      childTaint?.childReadExternal() === true
        ? { untrusted: { kind: "external", source: `sub-agent ${subagentLabel}` } }
        : {};
    let childSpend: RunSpendReport | undefined;
    const response = yield* AgentRunner.runRecursive({
      agent: subAgent,
      userInput: wrappedTask,
      conversationId: generateConversationId("subagent"),
      ...(context.telemetryTraceParent && {
        telemetryParent: {
          ...context.telemetryTraceParent,
          ...(context.toolCallId ? { parentToolCallId: context.toolCallId } : {}),
        },
      }),
      // Each level gets a fresh budget of the same size, so a child's own children are capped
      // identically to this child rather than falling back to the attended default.
      maxIterations: context.maxSubagentIterations ?? DEFAULT_MAX_SUBAGENT_ITERATIONS,
      ...(context.maxSubagentIterations !== undefined
        ? { maxSubagentIterations: context.maxSubagentIterations }
        : {}),
      ...(remainingBudget.maxDurationMs !== undefined
        ? { maxDurationMs: remainingBudget.maxDurationMs }
        : {}),
      ...(remainingBudget.maxCostUSD !== undefined
        ? { maxCostUSD: remainingBudget.maxCostUSD }
        : {}),
      ...(remainingBudget.maxTokens !== undefined ? { maxTokens: remainingBudget.maxTokens } : {}),
      // Every way the child ends, a failure included, is paid for by the parent.
      onRunSpend: (spend) => {
        childSpend = spend;
        if (spend.costUSD !== undefined && spend.costUSD > 0) {
          context.recordChildCost?.(spend.costUSD);
        }
        if (spend.costIncomplete) {
          context.recordChildCostUnknown?.();
        }
      },
      ephemeralRegionId: regionId,
      // Only where something can address the child: the user through its panel, or the
      // parent through steer_subagent.
      ...(presentation.takeEphemeralRegionMessage !== undefined || hooks !== undefined
        ? {
            checkQueuedMessage: () => {
              const fromParent = hooks?.takeParentMessage();
              if (fromParent !== undefined) {
                Effect.runSync(
                  presentation.recordEphemeralRegionParentMessage !== undefined
                    ? presentation.recordEphemeralRegionParentMessage(regionId, fromParent)
                    : presentation.appendEphemeralRegion(regionId, `↳ parent: ${fromParent}`),
                );
                return frameParentMessage(fromParent);
              }
              if (presentation.takeEphemeralRegionMessage === undefined) {
                return undefined;
              }
              const steering = Effect.runSync(presentation.takeEphemeralRegionMessage(regionId));
              return steering === undefined ? undefined : frameSteeringMessage(steering);
            },
          }
        : {}),
      ...(hooks !== undefined
        ? {
            beforeStep: () =>
              Effect.gen(function* () {
                const pausing = hooks.pauseRequested();
                if (pausing) {
                  yield* presentation.appendEphemeralRegion(
                    regionId,
                    "⏸ Paused by the parent agent",
                  );
                }
                yield* hooks.beforeStep();
                if (pausing) {
                  yield* presentation.appendEphemeralRegion(regionId, "▶ Resumed");
                }
              }),
            onIterationSpend: hooks.reportSpend,
            onToolEvent: hooks.onToolEvent,
          }
        : {}),
      ...(context.subagents !== undefined
        ? { sharedCostExhausted: context.subagents.costExhausted }
        : {}),
      ...childRunAuthority(context),
      ...(childTaint !== undefined ? { egressTaint: childTaint.taint } : {}),
      subagentDepth: currentDepth + 1,
      ...(context.onAutoApproveCommand
        ? { onAutoApproveCommand: context.onAutoApproveCommand }
        : {}),
      ...(context.onAutoApproveTool ? { onAutoApproveTool: context.onAutoApproveTool } : {}),
    }).pipe(
      Effect.tapError(() =>
        presentation.collapseEphemeralRegion(regionId, subagentLabel, {
          status: "failed",
          durationMs: Date.now() - startedAt,
        }),
      ),
      // Interruption is not a typed error, so tapError never sees it.
      // Without this, any abort that doesn't go through the double-Esc
      // handler leaves the subagent panel stuck live.
      Effect.onInterrupt(() =>
        presentation.collapseEphemeralRegion(regionId, subagentLabel, {
          status: "interrupted",
          durationMs: Date.now() - startedAt,
        }),
      ),
      // Bracket the sub-run for --events consumers, whatever the outcome.
      Effect.ensuring(
        context.emitEvent
          ? Effect.suspend(
              () =>
                context.emitEvent?.({
                  type: "subagent_complete",
                  agentName: subagentLabel,
                  durationMs: Date.now() - startedAt,
                }) ?? Effect.void,
            )
          : Effect.void,
      ),
    );

    const childCostUnknown =
      childSpend?.costIncomplete === true ||
      (response.costUSD === undefined &&
        !isZeroCostLocalModel(subAgent.config.llm.provider, subAgent.config.llm.model));

    let result = response.content;
    const stoppedAt = subagentStopReason(response);
    if (stoppedAt !== undefined) {
      const parts: string[] = [];
      for (const msg of response.messages ?? []) {
        if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
          parts.push(msg.content.trim());
        }
      }
      result =
        parts.length > 0
          ? `[Sub-agent stopped at its ${stoppedAt} before finishing. Partial results below]\n\n${parts.join("\n\n")}`
          : `[Sub-agent stopped at its ${stoppedAt} before finishing, with no output]`;
    } else {
      const verdict = judgeAnswer(response);
      if (verdict.kind === "failed") {
        result = `[Sub-agent produced no answer: ${verdict.message}]`;
      }
    }

    const durationMs = Date.now() - startedAt;
    yield* presentation.collapseEphemeralRegion(regionId, subagentLabel, {
      status: "completed",
      durationMs,
      ...(response.costUSD !== undefined ? { costUSD: response.costUSD } : {}),
      ...(response.usage
        ? { totalTokens: response.usage.promptTokens + response.usage.completionTokens }
        : {}),
    });

    const fullResult = result?.trim() || "No output";

    if (args.resultSchema) {
      const structured = validateStructuredResult(fullResult, args.resultSchema, {
        id: subAgent.id,
        durationMs,
        ...(response.costUSD !== undefined ? { costUSD: response.costUSD } : {}),
        costKnown: !childCostUnknown,
      });
      if (!structured.ok) {
        yield* logger.warn("Sub-agent structured result failed validation", {
          parentAgentId: parentAgent.id,
          subagentId: subAgent.id,
          errorCount: structured.errors.length,
        });
        if (context.emitEvent) {
          yield* context.emitEvent({
            type: "subagent_result",
            subagentId: subAgent.id,
            agentName: subagentLabel,
            durationMs,
            ...(response.costUSD !== undefined ? { costUSD: response.costUSD } : {}),
            costKnown: !childCostUnknown,
            structuredResult: {
              requested: true,
              valid: false,
              ...(args.resultName ? { resultName: args.resultName } : {}),
              errorCount: structured.errors.length,
            },
          });
        }
        return {
          success: false,
          result: { rawSummary: fullResult, validationErrors: structured.errors },
          error: `Sub-agent structured result failed validation: ${structured.errors.join("; ")}`,
          ...externalProvenance(),
        };
      }

      if (context.emitEvent) {
        yield* context.emitEvent({
          type: "subagent_result",
          subagentId: subAgent.id,
          agentName: subagentLabel,
          durationMs,
          ...(response.costUSD !== undefined ? { costUSD: response.costUSD } : {}),
          costKnown: !childCostUnknown,
          structuredResult: {
            requested: true,
            valid: true,
            ...(args.resultName ? { resultName: args.resultName } : {}),
          },
        });
      }

      yield* logger.info("Sub-agent returned a validated structured result", {
        parentAgentId: parentAgent.id,
        subagentId: subAgent.id,
        durationMs,
      });
      return { success: true, result: structured.value, ...externalProvenance() };
    }

    yield* logger.info("Sub-agent completed", {
      parentAgentId: parentAgent.id,
      persona: args.persona,
      responseLength: (result || "").length,
    });

    return {
      success: true,
      result: result || "Sub-agent completed but returned no content.",
      ...externalProvenance(),
    };
  });
}

// ─── Background Sub-Agent Tools ──────────────────────────────────────

/** Longest single wait_subagents call: a sub-agent's own timeout. */
const MAX_WAIT_SECONDS = SUBAGENT_TIMEOUT_MS / 1000;
const DEFAULT_WAIT_SECONDS = 600;

const listSubagentsSchema = z.object({});

const waitSubagentsSchema = z.object({
  ids: z
    .array(z.string())
    .optional()
    .describe("agentIds to wait for; omit for every sub-agent of this run."),
  until: z
    .enum(["any", "all"])
    .optional()
    .describe(
      "all (default) returns once none is still running; any once one finishes or needs you.",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(`Longest wait, default ${String(DEFAULT_WAIT_SECONDS)}.`),
});

const steerSubagentSchema = z.object({
  id: z.string().describe("The agentId spawn_subagent returned."),
  action: z
    .enum(["message", "pause", "resume", "cancel"])
    .describe(
      "message adds guidance before its next step; pause holds it before its next model call; resume releases it; cancel stops it now.",
    ),
  message: z.string().optional().describe("The guidance, for action message."),
});

type WaitSubagentsArgs = z.infer<typeof waitSubagentsSchema>;
type SteerSubagentArgs = z.infer<typeof steerSubagentSchema>;

const NO_SUPERVISOR_ERROR = "Sub-agents are not available in this run.";

// ─── Summarize Tool ──────────────────────────────────────────────────

const summarizeContextSchema = z.object({});

/**
 * Creates the sub-agent and summarize tools.
 *
 * These tools allow the agent to:
 * - Delegate specialised tasks to lightweight sub-agents (codebase exploration, deep research, etc.)
 * - Explicitly compact the current context window on demand
 */

export function createSubagentTools(): Tool<ToolRequirements>[] {
  // We cast to Tool<ToolRequirements>[] because the tools' handlers depend on
  // services (ToolRegistry, etc.) that are provided by the agent execution runtime
  // but aren't expressible in the ToolRequirements union due to circular dependency constraints.
  return [
    defineTool({
      name: "spawn_subagent",
      companionTools: ["wait_subagents", "list_subagents", "steer_subagent"],
      disclosure: "private",
      description: `Delegate a self-contained task to a child agent with a fresh context. Returns an agentId at once while the child works; collect its final answer with wait_subagents, and steer it with steer_subagent. Use it when the work would flood this context, for independent investigations run in parallel (start them all, then wait once), or for a specialist persona. Do small lookups and ordered edits to the same files yourself. The child gets at most your tools and the same model, a 30-minute timeout; at most ${String(MAX_LIVE_SUBAGENTS)} run at once and nesting stops at depth 3.`,
      parameters: spawnSubagentSchema,
      hidden: false,
      // Spawning grants nothing: the child holds at most this run's tools under this run's
      // policy (`childRunAuthority`), and every call it makes is gated as if made here.
      peerGrantRequired: true,
      riskLevel: "read-only",
      validate: makeZodValidator(spawnSubagentSchema),
      handler: (args: SpawnSubagentArgs, context) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          const parentAgent = context.parentAgent;

          if (!parentAgent) {
            return {
              success: false,
              result: null,
              error:
                "Sub-agent tool requires parent agent context. This is a bug — please report it.",
            };
          }

          // Refuse rather than silently running the child at the wrong depth: a
          // parent told its delegation was declined can do the work itself.
          const currentDepth = context.subagentDepth ?? 0;
          const maxDepth = context.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
          if (currentDepth >= maxDepth) {
            yield* logger.info("Sub-agent spawn refused at depth limit", {
              parentAgentId: parentAgent.id,
              currentDepth,
              maxDepth,
            });
            return {
              success: false,
              result: null,
              error:
                `Sub-agent nesting limit reached (depth ${currentDepth} of ${maxDepth}). ` +
                `Do this task yourself instead of delegating it further.`,
            };
          }

          if (args.resultSchema) {
            const schemaErrors = validateResultSchema(args.resultSchema);
            if (schemaErrors.length > 0) {
              return {
                success: false,
                result: null,
                error: `Invalid resultSchema: ${schemaErrors.join("; ")}`,
              };
            }
          }

          const remainingBudget = context.remainingRunBudget?.() ?? {};
          const exhausted = exhaustedBudget(remainingBudget);
          if (exhausted !== undefined) {
            return {
              success: false,
              result: null,
              error: `No ${exhausted} is left in this run's budget to delegate. Finish with what you have.`,
            };
          }

          const supervisor = context.subagents;
          if (supervisor === undefined) {
            return {
              success: false,
              result: null,
              error: "Sub-agents are not available in this run. Do this task yourself.",
            };
          }
          if (supervisor.liveCount() >= MAX_LIVE_SUBAGENTS) {
            return {
              success: false,
              result: null,
              error: `${String(MAX_LIVE_SUBAGENTS)} sub-agents are already running. Call wait_subagents or cancel one with steer_subagent before starting another.`,
            };
          }

          const subagentLabel = args.name?.trim() || `Sub-Agent (${args.persona})`;
          const hooks = supervisor.register({ name: subagentLabel });
          yield* supervisor.start(
            hooks.id,
            runSubagent(args, context, {
              parentAgent,
              currentDepth,
              remainingBudget,
              subagentLabel,
              hooks,
            }).pipe(
              Effect.timeoutFail({
                duration: Duration.millis(SUBAGENT_TIMEOUT_MS),
                onTimeout: () => new Error("The sub-agent reached its 30-minute timeout."),
              }),
              Effect.catchAllCause((cause) =>
                Effect.succeed<ToolExecutionResult>({
                  success: false,
                  result: null,
                  error: Cause.isInterruptedOnly(cause)
                    ? "The sub-agent was stopped."
                    : toError(Cause.squash(cause)).message,
                }),
              ),
            ),
          );
          return {
            success: true,
            result: {
              agentId: hooks.id,
              name: subagentLabel,
              status: "running",
              note: "Started. Keep working; call wait_subagents to collect its result, and steer_subagent to message, pause, resume or cancel it.",
            },
          };
        }),
      createSummary: (result) => {
        if (!result.success) return `Sub-agent failed: ${result.error}`;
        const content = String(result.result);
        return `Sub-agent returned ${content.length} chars`;
      },
    }),

    defineTool({
      name: "list_subagents",
      disclosure: "private",
      description:
        "Show each sub-agent of this run: status (running, paused, waiting-approval, completed, failed, cancelled), what it is doing, what it has spent, and retrieveId once finished. Returns at once. Read answers with wait_subagents.",
      parameters: listSubagentsSchema,
      hidden: false,
      peerGrantRequired: true,
      riskLevel: "read-only",
      validate: makeZodValidator(listSubagentsSchema),
      handler: (_args: Record<string, never>, context) =>
        Effect.sync(() => {
          const supervisor = context.subagents;
          if (supervisor === undefined) {
            return { success: false, result: null, error: NO_SUPERVISOR_ERROR };
          }
          const subagents = supervisor.list();
          const untrusted = combinedProvenance(subagents);
          return {
            success: true,
            result: { subagents },
            ...(untrusted !== undefined ? { untrusted } : {}),
          };
        }),
      createSummary: (result) =>
        result.success ? "Listed sub-agents" : `list_subagents failed: ${result.error}`,
    }),
    defineTool({
      name: "wait_subagents",
      disclosure: "private",
      longRunning: true,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
      description:
        "Wait for sub-agents and get their answers in one call: until all (default) returns once none is still running, until any once one finishes or is paused. Each answer comes once; a long one comes as a preview whose resultNote says how to read the whole answer. Use it instead of checking list_subagents repeatedly.",
      parameters: waitSubagentsSchema,
      hidden: false,
      peerGrantRequired: true,
      riskLevel: "read-only",
      validate: makeZodValidator(waitSubagentsSchema),
      handler: (args: WaitSubagentsArgs, context) =>
        Effect.gen(function* () {
          const supervisor = context.subagents;
          if (supervisor === undefined) {
            return { success: false, result: null, error: NO_SUPERVISOR_ERROR };
          }
          const ids = args.ids ?? [];
          const known = new Set(supervisor.list().map((snapshot) => snapshot.id));
          const unknown = ids.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            return {
              success: false,
              result: null,
              error: `No sub-agent ${unknown.join(", ")} in this run. Sub-agents stop when the run that started them ends.`,
            };
          }
          const outcome = yield* supervisor.wait(
            ids,
            args.until ?? "all",
            (args.timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1000,
          );
          const subagents = fitSubagentResults(
            outcome.subagents,
            DEFAULT_TOOL_RESULT_MAX_CHARS,
            (fitted) => JSON.stringify({ subagents: fitted, timedOut: outcome.timedOut }),
          );
          const untrusted = combinedProvenance(subagents);
          return {
            success: true,
            result: { subagents, timedOut: outcome.timedOut },
            ...(untrusted !== undefined ? { untrusted } : {}),
          };
        }),
      createSummary: (result) =>
        result.success ? "Waited for sub-agents" : `wait_subagents failed: ${result.error}`,
    }),
    defineTool({
      name: "steer_subagent",
      disclosure: "private",
      description:
        "Steer a running sub-agent by its agentId: message it new guidance, pause it, resume it or cancel it. Messages and pauses take effect before its next model call; cancel stops it and its tools now.",
      parameters: steerSubagentSchema,
      hidden: false,
      peerGrantRequired: true,
      riskLevel: "read-only",
      validate: makeZodValidator(steerSubagentSchema),
      handler: (args: SteerSubagentArgs, context) =>
        Effect.gen(function* () {
          const supervisor = context.subagents;
          if (supervisor === undefined) {
            return { success: false, result: null, error: NO_SUPERVISOR_ERROR };
          }
          const outcome = yield* supervisor.steer(args.id, args.action, args.message);
          return outcome.ok
            ? { success: true, result: { id: args.id, status: outcome.status, note: outcome.note } }
            : { success: false, result: null, error: outcome.error };
        }),
      createSummary: (result) =>
        result.success ? "Steered sub-agent" : `steer_subagent failed: ${result.error}`,
    }),
    defineTool({
      name: "summarize_context",
      disclosure: "private",
      longRunning: true,
      description:
        "Summarize older messages to free context. Call it only when you need space before the automatic compaction at 80% of the window.",
      parameters: summarizeContextSchema,
      hidden: false,
      riskLevel: "read-only",
      validate: makeZodValidator(summarizeContextSchema),
      handler: (_args, context) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          const parentAgent = context.parentAgent;
          const conversationMessages = context.conversationMessages;

          if (!parentAgent) {
            return {
              success: false,
              result: null,
              error:
                "Summarize tool requires parent agent context. This is a bug — please report it.",
            };
          }

          if (!conversationMessages || conversationMessages.length === 0) {
            return {
              success: true,
              result: "No conversation history to summarize.",
            };
          }

          yield* logger.info("Starting context summarization", {
            messageCount: conversationMessages.length,
            parentAgentId: parentAgent.id,
          });

          // Fetch model's actual context window from models.dev (used for splitting budget)
          const modelMetadata = yield* Effect.tryPromise({
            try: () =>
              getModelsDevMetadata(parentAgent.config.llm.model, parentAgent.config.llm.provider),
            catch: () => new Error("Failed to fetch model metadata"),
          }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

          const contextWindowMaxTokens = resolveEffectiveContextWindow({
            provider: parentAgent.config.llm.provider,
            ...(modelMetadata && { modelMaxTokens: modelMetadata.contextWindow }),
            ...(typeof parentAgent.config.llm.numCtx === "number" && {
              pinnedContextWindow: parentAgent.config.llm.numCtx,
            }),
            ...(typeof parentAgent.config.llm.maxContextTokens === "number" && {
              agentMaxTokens: parentAgent.config.llm.maxContextTokens,
            }),
          }).tokens;

          const runRecursive: RecursiveRunner = (runOpts) =>
            AgentRunner.runRecursive({
              ...runOpts,
              ...(context.recordSideSpend ? { onRunSpend: context.recordSideSpend } : {}),
            });

          // The same path automatic compaction takes, so an earlier summary is merged
          // into the new one rather than dropped, and the result is journaled. Memory
          // extraction runs under this run's own gate, set on the context by the loop:
          // calling the tool instead of waiting for the 80% mark must not decide whether
          // durable facts reach memory. Absent means no.
          const outcome = yield* Summarizer.compact(
            [...conversationMessages] as unknown as ConversationMessages,
            parentAgent,
            context.conversationId ?? generateConversationId("summary"),
            runRecursive,
            contextWindowMaxTokens,
            context.allowMemoryExtraction ?? false,
          );

          if (outcome === undefined) {
            return {
              success: true,
              result:
                "Not enough conversation history to summarize — need at least a few messages beyond the system prompt.",
            };
          }

          // Replace messages in the executor loop via callback
          if (context.compactConversation) {
            context.compactConversation(outcome.messages);
          }

          const tokensSaved = outcome.tokensBefore - outcome.tokensAfter;
          yield* logger.info("Context summarization completed", {
            originalMessageCount: conversationMessages.length,
            compactedMessageCount: outcome.messages.length,
            tokensSaved,
          });

          return {
            success: true,
            result: `Context compacted from ${conversationMessages.length} to ${outcome.messages.length} messages (saved ~${tokensSaved} tokens).`,
          };
        }),
      createSummary: (result) => {
        if (!result.success) return `Summarization failed: ${result.error}`;
        const content = String(result.result);
        return `Context summarized (${content.length} chars)`;
      },
    }),
  ] as Tool<ToolRequirements>[];
}

/** The first budget the parent has used up, named for the refusal, or undefined. */
function exhaustedBudget(remaining: RemainingRunBudget): string | undefined {
  if (remaining.maxDurationMs !== undefined && remaining.maxDurationMs <= 0) {
    return "time";
  }
  if (remaining.maxCostUSD !== undefined && remaining.maxCostUSD <= 0) {
    return "money";
  }
  if (remaining.maxTokens !== undefined && remaining.maxTokens <= 0) {
    return "token allowance";
  }
  return undefined;
}
