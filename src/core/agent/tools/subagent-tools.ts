import { Effect } from "effect";
import { z } from "zod";
import { DEFAULT_MAX_ITERATIONS } from "@/core/constants/agent";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";
import type { ConversationMessages } from "@/core/types/message";
import { getModelsDevMetadata } from "@/core/utils/models-dev";
import { AgentRunner } from "../agent-runner";
import { defineTool, makeZodValidator } from "./base-tool";
import { resolveEffectiveContextWindow } from "../context/effective-context-window";
import { Summarizer, type RecursiveRunner } from "../context/summarizer";

// ─── Constants ───────────────────────────────────────────────────────

/** Sub-agent execution timeout: 30 minutes */
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Monotonic counter for unique sub-agent IDs within this process */
let subagentCounter = 0;

// ─── Sub-Agent Tool ──────────────────────────────────────────────────

const spawnSubagentSchema = z.object({
  task: z
    .string()
    .describe("Specific task description for the sub-agent, including expected output."),
  name: z
    .string()
    .optional()
    .describe(
      "Short role label for this sub-agent (e.g. 'Curriculum coach', 'Food-safety instructor'). " +
        "Shown in the sub-agent panel so parallel sub-agents are distinguishable. " +
        "Defaults to 'Sub-Agent (<persona>)' when omitted.",
    ),
  persona: z
    .enum(["default", "coder", "researcher"])
    .optional()
    .default("default")
    .describe(
      "'coder' for code/git tasks, 'researcher' for research tasks, 'default' for general (default: 'default')",
    ),
});

type SpawnSubagentArgs = z.infer<typeof spawnSubagentSchema>;

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
      longRunning: true,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
      description:
        "Spawn a sub-agent with fresh context for a specific task. Personas: coder, researcher, default. " +
        "Pass a short 'name' to label each sub-agent by its role so parallel sub-agents stay distinguishable.",
      parameters: spawnSubagentSchema,
      hidden: false,
      riskLevel: "low-risk",
      validate: makeZodValidator(spawnSubagentSchema),
      handler: (args: SpawnSubagentArgs, context) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          const presentation = yield* PresentationServiceTag;
          const parentAgent = context.parentAgent;

          if (!parentAgent) {
            return {
              success: false,
              result: null,
              error:
                "Sub-agent tool requires parent agent context. This is a bug — please report it.",
            };
          }

          yield* logger.info("Spawning sub-agent", {
            task: args.task.substring(0, 200),
            persona: args.persona,
            parentAgentId: parentAgent.id,
          });

          const taskPreview = args.task.length > 80 ? `...${args.task.slice(-77)}` : args.task;
          const subagentLabel = args.name?.trim() || `Sub-Agent (${args.persona})`;
          const startedAt = Date.now();

          const regionId = yield* presentation.openEphemeralRegion("subagent", subagentLabel);
          yield* presentation.appendEphemeralRegion(regionId, `Task: ${taskPreview}`);

          // Create an ephemeral sub-agent with the parent's LLM config but a specific persona
          const subAgent: Agent = {
            id: `subagent-${++subagentCounter}-${Date.now()}`,
            name: subagentLabel,
            description: `Ephemeral sub-agent spawned for: ${args.task.substring(0, 100)}`,
            model: parentAgent.model,
            config: {
              ...parentAgent.config,
              persona: args.persona ?? "default",
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const personaHints: Record<string, string> = {
            coder: "You are a coding specialist. Focus on reading, writing, and modifying code.",
            researcher:
              "You are a research specialist. Focus on gathering, synthesising, and summarising information.",
          };
          const personaHint = personaHints[args.persona ?? ""] ?? "";

          const wrappedTask = `[SUB-AGENT TASK]
You are a sub-agent performing a delegated task for a parent agent. This is a ONE-SHOT task.
${personaHint ? `\n${personaHint}\n` : ""}
Rules:
- Complete the task and produce a answer
- Do NOT ask follow-up questions or wait for user input
- Do NOT continue searching indefinitely — gather enough information, then synthesise and respond
- If the task is ambiguous, state your assumptions briefly and proceed
- If you cannot complete the task fully, return what you found and explain why
- Stay within the scope of the task — do not take unrequested side actions
- Be concise; the parent agent needs the output, not background narration
- Your response will be returned directly to the parent agent

TASK:
${args.task}`;

          if (context.emitEvent) {
            yield* context.emitEvent({
              type: "subagent_start",
              task: taskPreview,
              agentName: subagentLabel,
            });
          }

          const response = yield* AgentRunner.runRecursive({
            agent: subAgent,
            userInput: wrappedTask,
            sessionId: context.sessionId ?? context.conversationId ?? `session-${Date.now()}`,
            conversationId: `subagent-conv-${++subagentCounter}-${Date.now()}`,
            maxIterations: context.parentMaxIterations ?? DEFAULT_MAX_ITERATIONS,
            ephemeralRegionId: regionId,
            ...(context.getAutoApprovePolicy
              ? { autoApprovePolicy: context.getAutoApprovePolicy }
              : {}),
            ...(context.autoApprovedCommands
              ? { autoApprovedCommands: context.autoApprovedCommands }
              : {}),
            ...(context.autoApprovedTools ? { autoApprovedTools: context.autoApprovedTools } : {}),
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
              context.emitEvent ? context.emitEvent({ type: "subagent_complete" }) : Effect.void,
            ),
          );

          // Fold the sub-agent's cost into the parent run's total so aggregated
          // pricing (one-shot JSON envelope, workflow history) includes sub-agent
          // spend. The interactive footer aggregates separately via each renderer.
          if (response.costUSD && context.recordChildCost) {
            context.recordChildCost(response.costUSD);
          }

          let result = response.content;
          if (!result?.trim() && response.messages?.length) {
            const parts: string[] = [];
            for (const msg of response.messages) {
              if (
                msg.role === "assistant" &&
                typeof msg.content === "string" &&
                msg.content.trim()
              ) {
                parts.push(msg.content.trim());
              }
            }
            if (parts.length > 0) {
              result = `[Sub-agent reached iteration limit. Partial results below]\n\n${parts.join("\n\n")}`;
            }
          }

          const durationMs = Date.now() - startedAt;
          yield* presentation.collapseEphemeralRegion(regionId, subagentLabel, {
            status: "completed",
            durationMs,
          });

          const fullResult = result?.trim() || "No output";
          const maxLines = 10;
          const previewLines = fullResult.split("\n").slice(-maxLines).join("\n");
          const indentedLines = previewLines.split("\n").map((line) => `     ${line}`);
          yield* presentation.writeOutput(indentedLines.join("\n"));

          yield* logger.info("Sub-agent completed", {
            parentAgentId: parentAgent.id,
            persona: args.persona,
            responseLength: (result || "").length,
          });

          return {
            success: true,
            result: result || "Sub-agent completed but returned no content.",
          };
        }),
      createSummary: (result) => {
        if (!result.success) return `Sub-agent failed: ${result.error}`;
        const content = String(result.result);
        return `Sub-agent returned ${content.length} chars`;
      },
    }),

    defineTool({
      name: "summarize_context",
      longRunning: true,
      description:
        "Compact conversation by summarizing older messages to free token budget. " +
        "Always performs summarization when called — use proactively before complex tasks " +
        "to reduce context size, save costs, and prevent context rot.",
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
              getModelsDevMetadata(parentAgent.config.llmModel, parentAgent.config.llmProvider),
            catch: () => new Error("Failed to fetch model metadata"),
          }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

          const contextWindowMaxTokens = resolveEffectiveContextWindow({
            provider: parentAgent.config.llmProvider,
            ...(modelMetadata && { modelMaxTokens: modelMetadata.contextWindow }),
            ...(typeof parentAgent.config.numCtx === "number" && {
              pinnedContextWindow: parentAgent.config.numCtx,
            }),
          }).tokens;

          const { systemMessage, messagesToSummarize, sanitizedRecentMessages } =
            Summarizer.splitMessages(
              [...conversationMessages] as unknown as ConversationMessages,
              contextWindowMaxTokens,
            );

          if (messagesToSummarize.length === 0) {
            return {
              success: true,
              result:
                "Not enough conversation history to summarize — need at least a few messages beyond the system prompt.",
            };
          }

          const runRecursive: RecursiveRunner = (runOpts) => AgentRunner.runRecursive(runOpts);

          // Summarize older messages into a single condensed message
          const summaryMessage = yield* Summarizer.summarizeHistory(
            messagesToSummarize,
            parentAgent,
            context.sessionId ?? context.conversationId ?? `session-${Date.now()}`,
            context.conversationId ?? `conv-${Date.now()}`,
            runRecursive,
          );

          const compacted = [
            systemMessage,
            summaryMessage,
            ...sanitizedRecentMessages,
          ] as ConversationMessages;

          // Replace messages in the executor loop via callback
          if (context.compactConversation) {
            context.compactConversation(compacted);
          }

          yield* logger.info("Context summarization completed", {
            originalMessageCount: conversationMessages.length,
            compactedMessageCount: compacted.length,
            summarizedMessageCount: messagesToSummarize.length,
          });

          return {
            success: true,
            result: `Context compacted from ${conversationMessages.length} to ${compacted.length} messages (summarized ${messagesToSummarize.length} older messages).`,
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
