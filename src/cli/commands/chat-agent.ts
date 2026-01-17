import { Effect } from "effect";
import { getAgentByIdentifier } from "../../core/agent/agent-service";
import { ChatServiceTag } from "../../core/interfaces/chat-service";
import { LoggerServiceTag } from "../../core/interfaces/logger";
import { TerminalServiceTag } from "../../core/interfaces/terminal";
import { AgentNotFoundError } from "../../core/types/errors";
import { CommonSuggestions } from "../../core/utils/error-handler";

/**
 * CLI commands for AI-powered chat agent interactions
 *
 * These commands handle conversational AI agents that can interact with users through
 * natural language chat interfaces. They integrate with LLM providers and support
 * real-time chat, special commands, and tool usage.
 */

/**
 * Chat with an AI agent
 */
export function chatWithAIAgentCommand(
  agentIdentifier: string,
  options?: {
    stream?: boolean;
  },
) {
  return Effect.gen(function* () {
    const normalizedIdentifier = agentIdentifier.trim();

    if (normalizedIdentifier.length === 0) {
      return yield* Effect.fail(
        new AgentNotFoundError({
          agentId: normalizedIdentifier,
          suggestion: CommonSuggestions.checkAgentExists("<empty>"),
        }),
      );
    }

    const agent = yield* getAgentByIdentifier(normalizedIdentifier).pipe(
      Effect.catchTag("StorageNotFoundError", () =>
        Effect.fail(
          new AgentNotFoundError({
            agentId: normalizedIdentifier,
            suggestion: CommonSuggestions.checkAgentExists(normalizedIdentifier),
          }),
        ),
      ),
    );

    const terminal = yield* TerminalServiceTag;
    yield* terminal.heading(`🤖 Starting chat with AI agent: ${agent.name} (reasoning: ${agent.config.reasoningEffort ?? "disabled" })`);
    if (agent.description) {
      yield* terminal.log(`   Description: ${agent.description}`);
    }
    yield* terminal.log("");
    yield* terminal.info("Type '/exit' to end the conversation.");
    yield* terminal.info("Type '/help' to see available special commands.");
    yield* terminal.log("");

    // Start the chat session using the chat service
    const chatService = yield* ChatServiceTag;
    yield* chatService.startChatSession(agent, options).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const logger = yield* LoggerServiceTag;
          yield* logger.error("Chat session error", { error });
          yield* terminal.error(`Chat session error: ${String(error)}`);
          return yield* Effect.void;
        }),
      ),
    );
  });
}
