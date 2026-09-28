import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { ChatServiceTag } from "@jazz/core/interfaces/chat-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { CommonSuggestions } from "@jazz/core/presentation/error-handler";
import { AgentNotFoundError, InteractiveTerminalRequiredError } from "@jazz/core/types/errors";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { Effect } from "effect";
import { continuedSessionOptions, type ContinueOptions } from "./continue-conversation";
import { sessionOpenLine } from "./session-open";

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
  } & ContinueOptions,
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
    yield* terminal.log(sessionOpenLine(agent));
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

    const continued = yield* continuedSessionOptions(agent, options);
    options = { ...options, ...continued };
    if (continued.initialHistory !== undefined) {
      yield* terminal.info(
        `Continuing a saved conversation (${continued.initialHistory.length} messages).`,
      );
    }

    // Start the chat session using the chat service
    const chatService = yield* ChatServiceTag;
    const sessionEnd = yield* chatService.startChatSession(agent, options).pipe(
      // Don't leave a stale agent name in the tab title after the session.
      Effect.ensuring(Effect.ignore(terminal.setTitle("🎷 Jazz"))),
    );
    if (sessionEnd.reason === "end-of-input" && sessionEnd.messagesReceived === 0) {
      return yield* Effect.fail(
        new InteractiveTerminalRequiredError({
          command: "jazz agent chat",
          message: "no messages arrived on stdin, and there is no terminal to type them in.",
          suggestion: `Run it in a terminal, or pipe messages on stdin, one per line: echo "hello" | jazz agent chat ${agent.id}`,
        }),
      );
    }
  });
}
