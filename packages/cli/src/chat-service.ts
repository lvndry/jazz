/**
 * ChatService implementation: drives an interactive chat session with an
 * agent — the message loop, slash-command dispatch, and session lifecycle
 * (persistence, working directory) glue live here.
 */

import { FileSystem } from "@effect/platform";
import {
  loadCommandApprovals,
  recordCommandApproval,
  removeCommandApproval,
  bumpPromotionThreshold,
  type CommandApprovals,
} from "@jazz/adapters/command-approval-tracker";
import { AgentRunner, type AgentRunnerOptions } from "@jazz/core/agent/agent-runner";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { ChatServiceTag, type ChatService } from "@jazz/core/interfaces/chat-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "@jazz/core/interfaces/fs";
import { JazzStateServiceTag, type JazzStateService } from "@jazz/core/interfaces/jazz-state";
import { type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@jazz/core/interfaces/mcp-server";
import { type PresentationService } from "@jazz/core/interfaces/presentation";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@jazz/core/interfaces/tool-registry";
import {
  getSkillIndexLine,
  SkillServiceTag,
  type SkillService,
} from "@jazz/core/skills/skill-service";
import {
  GenerationInterruptedError,
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMRequestError,
} from "@jazz/core/types/errors";
import type { Agent } from "@jazz/core/types/index";
import { type ChatMessage } from "@jazz/core/types/message";
import type { AutoApprovePolicy } from "@jazz/core/types/tools";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { isRetryableLLMError } from "@jazz/core/utils/llm-error";
import { conversationLogGroup } from "@jazz/core/utils/log-group";
import type { WorkflowService } from "@jazz/core/workflows/workflow-service";
import chalk from "chalk";
import { Effect, Layer } from "effect";
import { hydrateTranscriptFromHistory } from "@/cli/ui/hydrate-transcript";
import { store } from "@/cli/ui/store";
import { handleSpecialCommand, parseSpecialCommand, setSkillCommands } from "./chat/commands";
import type { CommandContext, CommandResult } from "./chat/commands/types";
import { persistConversationIfNeeded } from "./chat/persist-conversation";
import {
  initializeSession,
  logMessageToSession,
  setupAgent,
  updateWorkingDirectoryInStore,
} from "./chat/session";

/**
 * Chat service implementation for managing interactive chat sessions with AI agents
 */
export class ChatServiceImpl implements ChatService {
  startChatSession(
    agent: Agent,
    options?: {
      stream?: boolean;
      initialHistory?: ChatMessage[];
      initialConversationTitle?: string;
      maxIterations?: number;
      ephemeral?: boolean;
    },
  ): Effect.Effect<
    void,
    never,
    | TerminalService
    | LoggerService
    | FileSystemContextService
    | FileSystem.FileSystem
    | typeof AgentConfigServiceTag
    | JazzStateService
    | ToolRegistry
    | AgentService
    | LLMService
    | PresentationService
    | MCPServerManager
    | ToolRequirements
    | SkillService
    | WorkflowService
  > {
    return Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      const logger = yield* LoggerServiceTag;

      let conversationId: string = generateConversationId();

      // Logs and todos are keyed by the conversation, so this is re-pointed whenever the
      // conversation changes rather than bound once for the whole sitting.
      yield* logger.setLogGroup(conversationLogGroup(agent.id, conversationId));

      // Initialize session before the loop
      const fileSystemContext = yield* FileSystemContextServiceTag;
      yield* initializeSession(agent, conversationId).pipe(
        Effect.catchAll(() =>
          Effect.gen(function* () {
            yield* logger.error("Session initialization error");
          }),
        ),
      );

      // The interface needs to know which conversation it is showing so history search can
      // be narrowed to it. Set here and wherever the id changes, so the two never drift.
      store.setCurrentConversation({ agentId: agent.id, conversationId });

      updateWorkingDirectoryInStore(
        agent.id,
        conversationId,
        fileSystemContext,
        store.setWorkingDirectory,
      );

      // Agent setup phase: Connect to MCP servers and register tools before first message
      // Errors are handled gracefully inside setupAgent - conversation continues even if some MCPs fail
      yield* setupAgent(agent, conversationId);

      // Register skills as invokable slash commands so they appear in the "/"
      // autocomplete menu and can be run like any built-in command. Failures
      // here are non-fatal — the menu simply omits skills.
      yield* Effect.gen(function* () {
        const skillService = yield* SkillServiceTag;
        const skills = yield* skillService.listSkills();
        setSkillCommands(
          skills.map((skill) => ({ name: skill.name, description: getSkillIndexLine(skill) })),
        );
      }).pipe(Effect.catchAll(() => Effect.void));

      store.resetRunStats({ provider: agent.config.llmProvider, model: agent.config.llmModel });

      const ephemeral = options?.ephemeral === true;

      let chatActive = true;
      let conversationHistory: ChatMessage[] = options?.initialHistory ?? [];
      if (conversationHistory.length > 0) {
        hydrateTranscriptFromHistory(conversationHistory);
      }
      let loggedMessageCount = 0;
      let sessionUsage = { promptTokens: 0, completionTokens: 0 };
      let autoApprovePolicy: AutoApprovePolicy | undefined = undefined;
      let autoApprovedCommands: string[] = [];
      const autoApprovedTools: string[] = [];
      const sessionStartedAt = new Date();
      let startedAt = sessionStartedAt.toISOString();
      let conversationTitle: string | null = options?.initialConversationTitle ?? null;

      // Load persistent auto-approved commands from config
      const configService = yield* AgentConfigServiceTag;
      const appConfig = yield* configService.appConfig;
      if (appConfig.autoApprovedCommands?.length) {
        autoApprovedCommands = [...appConfig.autoApprovedCommands];
      }

      // Load last-used agent from runtime state for sorting /agents and /switch
      const jazzState = yield* JazzStateServiceTag;
      const lastUsedAgentId = yield* jazzState.get("wizard.lastUsedAgentId").pipe(
        Effect.map((value) => (typeof value === "string" ? value : null)),
        Effect.catchAll(() => Effect.succeed(null)),
      );

      // Register mode switch handler for Shift+Tab toggle
      store.registerModeSwitchHandler((mode) => {
        const newPolicy = mode === "yolo";
        if (autoApprovePolicy !== newPolicy) {
          autoApprovePolicy = newPolicy;
          store.setModeIsYolo(newPolicy);
          const message =
            mode === "yolo"
              ? "🚀 Switched to yolo mode — all tool calls auto-approved"
              : "🛡️ Switched to safe mode — all tool calls require approval";
          store.showModeToast(message);
        }
      });

      // Bound conversation history to prevent unbounded memory growth.
      // The agent's own ContextWindowManager (50K tokens) handles per-turn
      // trimming with tool-call integrity; this outer cap is a simple safety
      // net so the between-turn array doesn't grow without limit.
      const MAX_CHAT_HISTORY_MESSAGES = 2000;

      // True after a turn ended in a caught error. Decides whether queued
      // text auto-flushes (clean-finish path) or seeds the next prompt for
      // editing (error path).
      let lastTurnErrored = false;

      while (chatActive) {
        let userMessage: string | undefined;
        const queuedEntryCount = store.getMessageQueueSnapshot().length;
        const queued = store.peekQueue();
        // A flush (Esc with queued messages during a run) takes priority over the
        // error path: even though the prior turn was interrupted, the user asked
        // for the queue to go into the chat now, not to be re-edited.
        const flushRequested = store.consumeFlushQueue();
        // A multi-entry drain is prose for the agent even if the first entry
        // starts with "/" — parsing the joined text as one command would
        // silently discard the other entries.
        let drainedMultipleEntries = false;

        if (queued.length > 0 && (!lastTurnErrored || flushRequested)) {
          // Clean prior turn → drain the queue as the next user message
          // without re-prompting. Record entries in input history for ↑
          // recall parity with interactively typed messages.
          for (const entry of store.getMessageQueueSnapshot()) {
            store.pushInputHistory(entry);
          }
          store.takeQueue();
          userMessage = queued;
          drainedMultipleEntries = queuedEntryCount > 1;
          // Echo "You: <prompt>" to scrollback so the user can see when their
          // queued message was actually popped (vs when the LLM started
          // responding to it). The interactive ask() path emits the same
          // echo from terminal.ts on resolve; this path bypasses ask, so we
          // call terminal.user() — the shared helper that owns rendering.
          yield* terminal.user(userMessage);
        } else {
          const askOptions: { commandSuggestions: true; defaultValue?: string } = {
            commandSuggestions: true,
            ...(queued.length > 0 ? { defaultValue: queued } : {}),
          };
          userMessage = yield* terminal.ask("You:", askOptions).pipe(
            Effect.catchAll((error: unknown) => {
              // Handle ExitPromptError from inquirer when user presses Ctrl+C
              if (
                error instanceof Error &&
                (error.name === "ExitPromptError" || error.message.includes("SIGINT"))
              ) {
                // Exit gracefully on Ctrl+C - return /exit to trigger normal exit flow
                // The exit check below will handle the goodbye message and cleanup
                return Effect.succeed("/exit");
              }
              // Re-throw other errors, ensuring it's an Error instance
              return Effect.fail(error instanceof Error ? error : new Error(String(error)));
            }),
          );
          // Whatever the user submitted supersedes the seeded queue content.
          if (queued.length > 0) {
            store.clearQueue();
          }
        }
        lastTurnErrored = false;

        const trimmedMessage = (userMessage ?? "").trim();
        const lowerMessage = trimmedMessage.toLowerCase();
        if (lowerMessage === "/exit" || lowerMessage === "exit" || lowerMessage === "quit") {
          yield* terminal.log(chalk.dim.italic("— fin —"));

          // Cleanup: Disconnect all MCP servers and unregister mode handler before exiting
          store.registerModeSwitchHandler(null);
          try {
            const mcpManager = yield* MCPServerManagerTag;
            yield* mcpManager.disconnectAllServers().pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const logger = yield* LoggerServiceTag;
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  yield* logger.debug(`Error during MCP cleanup: ${errorMessage}`);
                  // Continue with exit even if cleanup fails
                }),
              ),
            );
          } catch {
            // Ignore errors during cleanup - we're exiting anyway
          }

          chatActive = false;
          continue;
        }

        if (!userMessage || trimmedMessage.length === 0) {
          yield* terminal.log(
            "(Tip) Type a message and press Enter, '/help' for commands, or '/exit' to quit.",
          );
          continue;
        }

        if (
          conversationTitle === null &&
          trimmedMessage.length > 0 &&
          !trimmedMessage.startsWith("/") &&
          !trimmedMessage.startsWith("!")
        ) {
          conversationTitle = trimmedMessage.slice(0, 80);
        }

        let messageForAgent = userMessage;

        // A message with interior newlines (multi-line composition or a
        // multi-line queued entry) is prose even when it starts with "/" or
        // "!" —
        // command parsing would silently discard everything after line one.
        if (
          (trimmedMessage.startsWith("/") || trimmedMessage.startsWith("!")) &&
          !drainedMultipleEntries &&
          !trimmedMessage.includes("\n")
        ) {
          const specialCommand = parseSpecialCommand(userMessage);

          // Commands that support pass-through: trailing text is sent as a message to the agent
          const passThroughMessage =
            specialCommand.type === "workflows" && specialCommand.args.length > 0
              ? specialCommand.args.join(" ").trim()
              : null;

          if (passThroughMessage !== null) {
            // Send the trailing text (e.g. "create") as the user message so the agent can guide
            messageForAgent = passThroughMessage;
            // Fall through to agent run below (do not continue)
          } else {
            const latestConfig = yield* configService.appConfig;
            const context: CommandContext = {
              agent,
              conversationId,
              conversationHistory,
              sessionUsage,
              sessionStartedAt,
              lastUsedAgentId,
              ...(autoApprovePolicy !== undefined ? { autoApprovePolicy } : {}),
              ...(autoApprovedCommands.length > 0 ? { autoApprovedCommands } : {}),
              ...(latestConfig.autoApprovedCommands?.length
                ? { persistedAutoApprovedCommands: latestConfig.autoApprovedCommands }
                : {}),
              ...(autoApprovedTools.length > 0 ? { autoApprovedTools } : {}),
            };
            const commandResult: CommandResult = yield* handleSpecialCommand(
              specialCommand,
              context,
            );

            if (commandResult.saveCurrentHistory) {
              yield* persistConversationIfNeeded({
                ephemeral,
                conversationTitle,
                conversationHistory,
                conversationId,
                agentId: agent.id,
                startedAt,
              });
            }

            if (commandResult.newConversationId !== undefined) {
              conversationId = commandResult.newConversationId;
              store.setCurrentConversation({ agentId: agent.id, conversationId });
              // Logs follow the conversation, so /new starts a new file rather than
              // appending the next conversation to the previous one's.
              yield* logger.setLogGroup(conversationLogGroup(agent.id, conversationId));
              conversationTitle = null;
              startedAt = new Date().toISOString();
              sessionUsage = { promptTokens: 0, completionTokens: 0 };
              // Initialize the new conversation
              const fileSystemContext = yield* FileSystemContextServiceTag;
              yield* initializeSession(agent, conversationId).pipe(
                Effect.catchAll(() =>
                  Effect.gen(function* () {
                    yield* logger.error("Session initialization error");
                  }),
                ),
              );
              // Update working directory in store after conversation change
              updateWorkingDirectoryInStore(
                agent.id,
                conversationId,
                fileSystemContext,
                store.setWorkingDirectory,
              );
            }
            if (commandResult.newAgent !== undefined) {
              agent = commandResult.newAgent;
              // Update working directory in store after agent switch
              const fileSystemContext = yield* FileSystemContextServiceTag;
              updateWorkingDirectoryInStore(
                agent.id,
                conversationId,
                fileSystemContext,
                store.setWorkingDirectory,
              );
            }
            if (commandResult.newHistory !== undefined) {
              conversationHistory = commandResult.newHistory;
              // The transcript is the user's picture of what the agent knows.
              // Any command that replaces the history — /new, /fork, /compact,
              // /resume — has to repaint it, or the screen keeps showing turns
              // the agent can no longer see.
              hydrateTranscriptFromHistory(conversationHistory);
              if (commandResult.resendMessage !== undefined) {
                // /retry replays the SAME conversation — keep the title (so
                // the exit-time save still fires) and clamp the session-log
                // cursor instead of resetting it (a reset would re-log the
                // entire pre-retry history as duplicate events).
                loggedMessageCount = Math.min(loggedMessageCount, conversationHistory.length);
              } else {
                // Reset logged message count when history is cleared (e.g., /new command)
                loggedMessageCount = 0;
                conversationTitle = null;
              }
            }
            if (commandResult.resetStartedAt) {
              startedAt = new Date().toISOString();
            }
            if (commandResult.newAutoApprovePolicy !== undefined) {
              autoApprovePolicy = commandResult.newAutoApprovePolicy || undefined;
              // Sync mode state with store for Shift+Tab toggle
              store.setModeIsYolo(autoApprovePolicy === true || autoApprovePolicy === "high-risk");
            }

            if (commandResult.addAutoApprovedCommand) {
              if (!autoApprovedCommands.includes(commandResult.addAutoApprovedCommand)) {
                autoApprovedCommands.push(commandResult.addAutoApprovedCommand);
              }

              const fs = yield* FileSystem.FileSystem;
              const fsLayer = Layer.succeed(FileSystem.FileSystem, fs);
              yield* Effect.forkDaemon(
                recordCommandApproval(commandResult.addAutoApprovedCommand, conversationId).pipe(
                  Effect.catchAll(() => Effect.void),
                  Effect.provide(fsLayer),
                ),
              );
            }
            if (commandResult.removeAutoApprovedCommand) {
              autoApprovedCommands = autoApprovedCommands.filter(
                (c) => c !== commandResult.removeAutoApprovedCommand,
              );
            }

            if (commandResult.resendMessage !== undefined) {
              // /retry — fall through to the agent run with the replayed
              // message instead of prompting again.
              messageForAgent = commandResult.resendMessage;
              yield* terminal.user(messageForAgent);
            } else if (commandResult.messageForAgent !== undefined) {
              // A leading `!` executes locally first; only the command result is
              // sent into the model turn, not the shell escape syntax itself.
              messageForAgent = commandResult.messageForAgent;
            } else {
              continue;
            }
          }
        }

        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const fsLayer = Layer.succeed(FileSystem.FileSystem, fs);

          // Create runner options
          // Use a getter for autoApprovePolicy to support real-time mode switches via Shift+Tab
          const getCurrentAutoApprovePolicy = () => autoApprovePolicy;

          const runnerOptions: AgentRunnerOptions = {
            agent,
            userInput: messageForAgent,
            conversationId,
            conversationHistory,
            ...(options?.stream !== undefined ? { stream: options.stream } : {}),
            ...(options?.maxIterations !== undefined
              ? { maxIterations: options.maxIterations }
              : {}),
            ...(ephemeral ? { disablePersistence: true } : {}),
            autoApprovePolicy: getCurrentAutoApprovePolicy,
            autoApprovedCommands,
            autoApprovedTools,
            onAutoApproveCommand: (command: string) =>
              Effect.gen(function* () {
                if (!autoApprovedCommands.includes(command)) {
                  autoApprovedCommands.push(command);
                }
                yield* Effect.forkDaemon(
                  recordCommandApproval(command, conversationId).pipe(
                    Effect.catchAll(() => Effect.void),
                    Effect.provide(fsLayer),
                  ),
                );
              }),
            onAutoApproveTool: (toolName: string) => {
              if (!autoApprovedTools.includes(toolName)) {
                autoApprovedTools.push(toolName);
              }
            },
            checkQueuedMessage: () => {
              const queued = store.takeQueue();
              if (queued.length === 0) return undefined;
              Effect.runSync(terminal.user(queued));
              return queued;
            },
            // A Ctrl+B-detached tool call reports back here, possibly long after this
            // run has ended. Queuing it through the same path as text typed mid-run
            // means it surfaces automatically — at the next tool-phase boundary if this
            // run is still going, or as the opening line of the next turn otherwise.
            onDetachedToolComplete: (summary: string) => {
              store.appendToQueue(`[Background task finished]\n${summary}`);
            },
          };

          // Run the agent with proper error handling
          store.setChatBusy(true);
          const response = yield* AgentRunner.run(runnerOptions).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                lastTurnErrored = true;
                // Stop the thinking spinner — the agent run failed before
                // streaming started, so nothing else will reset the activity.
                store.setActivity({ phase: "idle" });

                // Log error with detailed information
                const errorDetails: Record<string, unknown> = {
                  agentId: agent.id,
                  conversationId: conversationId || undefined,
                  errorMessage: String(error),
                };

                if (
                  error instanceof LLMRateLimitError ||
                  error instanceof LLMRequestError ||
                  error instanceof LLMAuthenticationError
                ) {
                  errorDetails["errorType"] = error._tag;
                  errorDetails["provider"] = error.provider;
                }

                if (error instanceof Error && error.stack) {
                  errorDetails["stack"] = error.stack;
                }

                yield* logger.error("Agent execution error", errorDetails);

                yield* terminal.log("");

                // Handle different error types with appropriate user feedback
                if (error instanceof LLMRateLimitError) {
                  yield* terminal.warn(
                    `Rate limit exceeded. The request was too large or you've hit your API limits.`,
                  );
                  yield* terminal.log(
                    "   Please try again in a moment or consider using a smaller context.",
                  );
                  yield* terminal.log(`   Error details: ${error.message}`);
                } else if (error instanceof LLMRequestError) {
                  // Extract clean error message without verbose details
                  const cleanMessage = error.message.split(" | ")[0] || error.message;
                  if (isRetryableLLMError(error)) {
                    yield* terminal.warn(
                      `Could not reach the LLM API (retries exhausted): ${cleanMessage}`,
                    );
                    yield* terminal.log("   Check your network connection and try again.");
                  } else {
                    yield* terminal.error(`LLM request failed: ${cleanMessage}`);
                    if (error.permanent !== true) {
                      yield* terminal.log("   This might be a temporary issue. Please try again.");
                    }
                  }
                } else if (error instanceof LLMAuthenticationError) {
                  yield* terminal.error(`Authentication failed: ${error.message}`);
                  if (error.provider === "ollama") {
                    yield* terminal.log(
                      "   Cloud models need a key from https://ollama.com/settings/keys (jazz config set llm.ollama.api_key <key>), or `ollama signin` to proxy through a local daemon.",
                    );
                  } else {
                    yield* terminal.log(
                      `   Run 'jazz config set llm.${error.provider}.api_key <key>' or 'jazz wizard' to fix.`,
                    );
                  }
                } else if (error instanceof GenerationInterruptedError) {
                  store.setActivity({ phase: "idle" });
                } else {
                  yield* terminal.error(`Error: ${String(error)}`);
                }
                yield* terminal.log("");

                // Return a minimal response to allow the loop to continue
                return {
                  conversationId: conversationId || "",
                  messages: conversationHistory,
                  content: "",
                };
              }),
            ),
            Effect.ensuring(Effect.sync(() => store.setChatBusy(false))),
          );

          // Store the conversation ID for continuity
          conversationId = response.conversationId;
          store.setCurrentConversation({ agentId: agent.id, conversationId });

          // Accumulate token usage for /cost (only on full AgentResponse, not error fallback)
          if ("usage" in response && response.usage) {
            sessionUsage = {
              promptTokens: sessionUsage.promptTokens + response.usage.promptTokens,
              completionTokens: sessionUsage.completionTokens + response.usage.completionTokens,
            };
          }

          // Persist conversation history for next turn and log new messages.
          // The in-memory bookkeeping (conversationHistory/loggedMessageCount)
          // still runs for ephemeral sessions — only the on-disk session log
          // (logMessageToSession) is skipped.
          if (response.messages) {
            // Log all new messages that haven't been logged yet
            const newMessages = response.messages.slice(loggedMessageCount);
            if (!ephemeral) {
              for (const message of newMessages) {
                yield* logMessageToSession(agent.id, conversationId, message);
              }
            }
            loggedMessageCount = response.messages.length;
            conversationHistory = response.messages;

            // Trim if history exceeds the outer safety cap
            if (conversationHistory.length > MAX_CHAT_HISTORY_MESSAGES) {
              conversationHistory = conversationHistory.slice(-MAX_CHAT_HISTORY_MESSAGES);
              loggedMessageCount = conversationHistory.length;
            }
          } else if (response.content) {
            // If we have content but no messages array, log both user and assistant messages
            if (!ephemeral) {
              const userChatMessage: ChatMessage = {
                role: "user",
                content: userMessage,
              };
              yield* logMessageToSession(agent.id, conversationId, userChatMessage);

              const assistantMessage: ChatMessage = {
                role: "assistant",
                content: response.content,
              };
              yield* logMessageToSession(agent.id, conversationId, assistantMessage);
            }
            loggedMessageCount += 2; // user message + assistant message
          } else {
            // If no messages array and no content, still log the user message
            if (!ephemeral) {
              const userChatMessage: ChatMessage = {
                role: "user",
                content: userMessage,
              };
              yield* logMessageToSession(agent.id, conversationId, userChatMessage);
            }
            loggedMessageCount += 1;
          }

          if (!lastTurnErrored) {
            yield* persistConversationIfNeeded({
              ephemeral,
              conversationTitle,
              conversationHistory,
              conversationId,
              agentId: agent.id,
              startedAt,
            });
          }

          // Display is handled entirely by AgentRunner (both streaming and non-streaming)
          // No need to display here - AgentRunner takes care of it

          // Update working directory in store after agent run (in case cd was called)
          const fileSystemContext = yield* FileSystemContextServiceTag;
          updateWorkingDirectoryInStore(
            agent.id,
            conversationId,
            fileSystemContext,
            store.setWorkingDirectory,
          );

          // Check for commands ready to promote to persistent config
          const currentConfig = yield* configService.appConfig;
          const persistedSet = new Set(currentConfig.autoApprovedCommands ?? []);
          const emptyApprovals: CommandApprovals = {};
          const approvals = yield* loadCommandApprovals().pipe(
            Effect.catchAll(() => Effect.succeed(emptyApprovals)),
          );

          for (const cmd of autoApprovedCommands) {
            if (persistedSet.has(cmd)) continue;
            const record = approvals[cmd];
            if (!record || record.sessionCount < record.nextPromptAt) continue;

            const promote = yield* terminal.confirm(
              `You've approved "${cmd}" in ${record.sessionCount} sessions. Always approve it?`,
              true,
            );
            if (promote) {
              const persisted = [...(currentConfig.autoApprovedCommands ?? [])];
              if (!persisted.includes(cmd)) {
                persisted.push(cmd);
                yield* configService.set("autoApprovedCommands", persisted);
              }
              yield* removeCommandApproval(cmd).pipe(Effect.catchAll(() => Effect.void));
              yield* terminal.success(`"${cmd}" will be auto-approved in all future sessions.`);
            } else {
              // Exponential backoff — bump threshold so we don't nag again soon
              yield* bumpPromotionThreshold(cmd).pipe(Effect.catchAll(() => Effect.void));
            }
          }
        });
      }

      yield* persistConversationIfNeeded({
        ephemeral,
        conversationTitle,
        conversationHistory,
        conversationId,
        agentId: agent.id,
        startedAt,
      });
    }).pipe(Effect.catchAll(() => Effect.void));
  }
}

/**
 * Create the chat service layer
 */
export function createChatServiceLayer(): Layer.Layer<
  ChatService,
  never,
  | TerminalService
  | LoggerService
  | FileSystemContextService
  | FileSystem.FileSystem
  | typeof AgentConfigServiceTag
  | JazzStateService
  | typeof ToolRegistryTag
  | typeof AgentServiceTag
> {
  return Layer.succeed(ChatServiceTag, new ChatServiceImpl());
}
