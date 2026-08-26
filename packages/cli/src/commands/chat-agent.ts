import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { ChatServiceTag } from "@jazz/core/interfaces/chat-service";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { CommonSuggestions } from "@jazz/core/presentation/error-handler";
import { AgentNotFoundError } from "@jazz/core/types/errors";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { Effect } from "effect";
import packageJson from "../../../../package.json";

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
    maxIterations?: number;
    ephemeral?: boolean;
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
    // Set terminal tab title to show agent name
    yield* terminal.setTitle(`🎷 Jazz - ${agent.name}`);
    yield* terminal.clear();
    yield* terminal.heading(
      `${agent.name} · ${agent.config.llmProvider}/${agent.config.llmModel} · jazz v${packageJson.version}`,
    );
    if (agent.description) {
      yield* terminal.log(`   ${agent.description}`);
    }
    yield* terminal.log("");
    yield* terminal.info(
      "/help commands & shortcuts · /exit quit · Esc Esc interrupt · Shift+Tab approval mode · Ctrl+R reasoning · Ctrl+O expand output",
    );
    if (options?.ephemeral === true) {
      yield* terminal.warn(
        "🕶️ Ephemeral session — nothing will be saved to history, memory, or the session log.",
      );
    }

    // Check if model supports tools and warn if not
    const modelMeta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
    );
    if (
      modelMeta &&
      !modelMeta.supportsTools &&
      agent.config.tools &&
      agent.config.tools.length > 0
    ) {
      yield* terminal.log("");
      yield* terminal.warn(
        `⚠️  The current model (${agent.config.llmModel}) does not support tools. Your configured tools will not be available.`,
      );
    }

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
      // Don't leave a stale agent name in the tab title after the session.
      Effect.ensuring(Effect.ignore(terminal.setTitle("🎷 Jazz"))),
    );
  });
}
