import { Effect } from "effect";
import { z } from "zod";
import { DEFAULT_CONTEXT_WINDOW } from "@/core/constants/models";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";
import type { ConversationMessages } from "@/core/types/message";
import { getModelsDevMetadata } from "@/core/utils/models-dev-client";
import { defineTool, makeZodValidator } from "./base-tool";
import { AgentRunner } from "../agent-runner";
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
  persona: z
    .enum(["default", "coder", "researcher"])
    .optional()
    .default("default")
    .describe(
      "'coder' for code/git tasks, 'researcher' for deep research tasks, 'default' for general (default: 'default')",
    ),
});

type SpawnSubagentArgs = z.infer<typeof spawnSubagentSchema>;

// ─── Summarize Tool ──────────────────────────────────────────────────

const summarizeContextSchema = z.object({});

/**
 * Extracts the first sentence from a text block for progress display.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  // Match up to a sentence-ending punctuation or first 120 chars
  const match = trimmed.match(/^[^.!?\n]+[.!?]?/);
  const sentence = match?.[0] ?? trimmed.substring(0, 120);
  return sentence.length > 120 ? `${sentence.substring(0, 117)}...` : sentence;
}

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
        "Spawn a sub-agent with fresh context for a specific task. Personas: coder, researcher, default.",
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

          // Show sub-agent launch to the user
          const taskPreview =
            args.task.length > 80 ? `${args.task.substring(0, 77)}...` : args.task;
          yield* presentation.presentThinking(`Sub-Agent (${args.persona})`, true);
          yield* presentation.writeOutput(`  ↳ Task: ${taskPreview}`);

          // Create an ephemeral sub-agent with the parent's LLM config but a specific persona
          const subAgent: Agent = {
            id: `subagent-${++subagentCounter}-${Date.now()}`,
            name: `Sub-Agent (${args.persona})`,
            description: `Ephemeral sub-agent spawned for: ${args.task.substring(0, 100)}`,
            model: parentAgent.model,
            config: {
              ...parentAgent.config,
              agentType: args.persona ?? "default",
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          // Wrap the task with sub-agent instructions to ensure one-shot completion
          const wrappedTask = `[SUB-AGENT TASK]
You are a sub-agent performing a delegated task for a parent agent. This is a ONE-SHOT task:
- Complete the task and produce a FINAL ANSWER in your response
- Do NOT ask follow-up questions or wait for user input
- Do NOT continue searching indefinitely — gather enough information, then synthesize and respond
- Your response will be returned directly to the parent agent

TASK:
${args.task}`;

          const response = yield* AgentRunner.runRecursive({
            agent: subAgent,
            userInput: wrappedTask,
            sessionId: context.sessionId ?? context.conversationId ?? `session-${Date.now()}`,
            conversationId: `subagent-conv-${++subagentCounter}-${Date.now()}`,
            maxIterations: 20,
          });

          // If the sub-agent hit the iteration limit, response.content may be empty
          // (the last iteration was tool calls with no text). Extract useful content
          // from the conversation messages so the parent gets intermediate results.
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

          // Show sub-agent result preview
          const resultPreview = firstSentence(result || "No output");
          yield* presentation.writeOutput(`  ↳ Result: ${resultPreview}`);
          yield* presentation.presentCompletion(`Sub-Agent (${args.persona})`);

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

          const contextWindowMaxTokens = modelMetadata?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

          // Split messages into system, older (to summarize), and recent (to keep verbatim).
          // Unlike compactIfNeeded (which checks a threshold first), the tool always
          // compacts when explicitly called — the agent knows best when to clear context.
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

          // Rebuild: [system, summary, ...recent]
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
