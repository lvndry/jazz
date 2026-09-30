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
import { getOwnedGoal } from "@jazz/adapters/goals/goal-actions";
import { claimChatGoalTurn, settleChatGoalTurn } from "@jazz/adapters/goals/goal-worker";
import {
  loadConversationOrNull,
  type ConversationUiEntry,
} from "@jazz/adapters/history/conversation-history-service";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { AgentRunner, type AgentRunnerOptions } from "@jazz/core/agent/agent-runner";
import { carryEgressTaint, detachedResultMessage } from "@jazz/core/agent/execution/egress-taint";
import type { RunOutcome } from "@jazz/core/agent/run/park-signal";
import type { AgentResponse, ChatTurnOptions } from "@jazz/core/agent/types";
import { apiKeyHint } from "@jazz/core/constants/provider-env-vars";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import {
  ChatServiceTag,
  type ChatService,
  type ChatSessionEnd,
} from "@jazz/core/interfaces/chat-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "@jazz/core/interfaces/fs";
import { JazzStateServiceTag, type JazzStateService } from "@jazz/core/interfaces/jazz-state";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { MCPServerManagerTag, type MCPServerManager } from "@jazz/core/interfaces/mcp-server";
import { type PersonaService } from "@jazz/core/interfaces/persona-service";
import { PluginRuntimeServiceTag } from "@jazz/core/interfaces/plugin-runtime";
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
  type CapCheck,
  capWindowKey,
  checkSpendCaps,
  describeCapCheck,
} from "@jazz/core/spend/caps";
import { localDayKey, localMonthKey } from "@jazz/core/spend/ledger";
import type { DaemonConfig } from "@jazz/core/types/config";
import {
  GenerationInterruptedError,
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMRequestError,
} from "@jazz/core/types/errors";
import type { Agent } from "@jazz/core/types/index";
import { type ChatMessage } from "@jazz/core/types/message";
import type { JsonValue, LifecycleEventId } from "@jazz/core/types/plugin";
import type { AutoApprovePolicy } from "@jazz/core/types/tools";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { toError } from "@jazz/core/utils/errors";
import { isRetryableLLMError } from "@jazz/core/utils/llm-error";
import { conversationLogGroup } from "@jazz/core/utils/log-group";
import type { WorkflowService } from "@jazz/core/workflows/workflow-service";
import chalk from "chalk";
import { Effect, Layer, Option } from "effect";
import { chatModeForPolicy, policyForChatMode, SAFE_MODE_POLICY } from "@/cli/chat/approval-mode";
import { reasoningEffortLabel } from "@/cli/helpers/reasoning";
import {
  deriveHerdrState,
  herdrBlockedReason,
  herdrReporter,
  installHerdrExitHooks,
  type HerdrSession,
} from "@/cli/integrations/herdr-agent-state";
import { hydrateTranscriptFromHistory } from "@/cli/ui/hydrate-transcript";
import { hydrateTranscriptFromUiEntries } from "@/cli/ui/hydrate-transcript";
import { resolveLocalModelHosts } from "@/cli/ui/local-model-hosts";
import { store } from "@/cli/ui/store";
import { classifyChatInput } from "./chat/chat-input";
import {
  handleSpecialCommand,
  isCommandInput,
  parseSpecialCommand,
  setPluginCommands,
  setSkillCommands,
} from "./chat/commands";
import {
  announceGoalTurn,
  announceWaitingGoals,
  goalLayers,
  offerGoalHandoffs,
  offerProposedGoals,
  pauseOnExit,
  settledHere,
} from "./chat/commands/goal";
import { announceWaitingLoops } from "./chat/commands/loop";
import {
  confirmSessionLimitOverage,
  estimateSessionCostUSD,
  findExceededSessionLimits,
} from "./chat/commands/session-limits";
import type { CommandContext, CommandResult, SessionLimits } from "./chat/commands/types";
import { inlineMentionedTextFiles } from "./chat/mentioned-files";
import { persistConversationIfNeeded, shouldSaveTurn } from "./chat/persist-conversation";
import {
  initializeSession,
  logMessageToSession,
  setupAgent,
  updateWorkingDirectoryInStore,
} from "./chat/session";

/**
 * Chat service implementation for managing interactive chat sessions with AI agents
 */
/**
 * Most messages kept between chat turns. The agent's own ContextWindowManager handles per-turn
 * trimming with tool-call integrity; this outer cap only stops the between-turn array from
 * growing without limit.
 */
export const MAX_CHAT_HISTORY_MESSAGES = 2000;

/** The newest `limit` messages, still marked as having read external content if any dropped one was. */
export function capChatHistory(
  history: readonly ChatMessage[],
  limit: number = MAX_CHAT_HISTORY_MESSAGES,
): ChatMessage[] {
  if (history.length <= limit) {
    return [...history];
  }
  return carryEgressTaint(history.slice(0, -limit), history.slice(-limit));
}

export class ChatServiceImpl implements ChatService {
  startChatSession(
    agent: Agent,
    options?: {
      stream?: boolean;
      conversationId?: string;
      initialHistory?: ChatMessage[];
      initialUiTranscript?: readonly ConversationUiEntry[];
      initialMessage?: string;
      maxIterations?: number;
      ephemeral?: boolean;
    },
  ): Effect.Effect<
    ChatSessionEnd,
    never,
    | TerminalService
    | LoggerService
    | FileSystemContextService
    | FileSystem.FileSystem
    | AgentConfigService
    | JazzStateService
    | ToolRegistry
    | AgentService
    | LLMService
    | PresentationService
    | MCPServerManager
    | ToolRequirements
    | SkillService
    | WorkflowService
    | PersonaService
  > {
    return Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      const logger = yield* LoggerServiceTag;

      let conversationId: string = options?.conversationId ?? generateConversationId();

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

      // If this chat runs in a Herdr pane, report its state there so the sidebar and
      // `herdr agent list` show the agent and can restore the session. A no-op outside
      // Herdr; a reporting error must never disturb the chat.
      const herdr = herdrReporter();
      const herdrActive = herdr.enabled;
      const reportHerdrState = (): void => {
        if (!herdrActive) return;
        try {
          const snapshot = store.getSessionSnapshot();
          herdr.reportState(deriveHerdrState(snapshot), herdrBlockedReason(snapshot));
        } catch {
          // Fail-open: the chat loop is the source of truth.
        }
      };
      const herdrUnsubscribe = herdrActive ? store.subscribeSession(reportHerdrState) : undefined;
      const reportHerdrSession = (id: string): void => {
        if (herdrActive)
          herdr.reportSession({ agent: agent.id, conversationId: id } satisfies HerdrSession);
      };
      if (herdrActive) {
        installHerdrExitHooks();
        reportHerdrSession(conversationId);
      }

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

      // Register enabled plugins' slash commands the same way. Non-fatal: the menu simply omits
      // plugin commands if the runtime is absent or listing fails.
      yield* Effect.gen(function* () {
        const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
        if (Option.isNone(runtimeOption)) return;
        const commands = yield* runtimeOption.value.listAgentCommands(agent.id);
        setPluginCommands(
          commands.map((command) => ({ name: command.name, description: command.description })),
        );
      }).pipe(Effect.catchAll(() => Effect.void));

      const configService = yield* AgentConfigServiceTag;
      const appConfig = yield* configService.appConfig;
      const llmService = yield* LLMServiceTag;
      const reasoning = reasoningEffortLabel(agent.config.llm.reasoning);
      store.resetRunStats({
        provider: agent.config.llm.provider,
        model: agent.config.llm.model,
        ...(reasoning === undefined ? {} : { reasoning }),
        localModelHosts: resolveLocalModelHosts(llmService, appConfig.llm),
      });

      const ephemeral = options?.ephemeral === true;

      let chatActive = true;
      let conversationHistory: ChatMessage[] = options?.initialHistory ?? [];
      let conversationTitle = ephemeral
        ? undefined
        : (yield* loadConversationOrNull(agent.id, conversationId))?.title;

      // Notify enabled plugins of chat lifecycle events (a Warp-style notifier rides these).
      // Fire-and-forget and fail-open so a plugin can never delay or break the loop.
      const emitLifecycle = (
        event: LifecycleEventId,
        data?: Readonly<Record<string, JsonValue>>,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
          if (Option.isNone(runtimeOption)) return;
          yield* runtimeOption.value.emitLifecycleEvent({
            event,
            agentId: agent.id,
            conversationId,
            cwd: process.cwd(),
            ...(data !== undefined ? { data } : {}),
          });
        }).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.forkDaemon,
          Effect.asVoid,
        );

      yield* emitLifecycle("session-start");
      if (options?.initialUiTranscript?.length) {
        hydrateTranscriptFromUiEntries(options.initialUiTranscript);
      } else if (conversationHistory.length > 0) {
        hydrateTranscriptFromHistory(conversationHistory);
      }
      if (!ephemeral && conversationHistory.length > 0) {
        yield* announceWaitingGoals(conversationId).pipe(Effect.ignore);
        yield* announceWaitingLoops(conversationId).pipe(Effect.ignore);
      }
      let loggedMessageCount = 0;
      let sessionUsage = { promptTokens: 0, completionTokens: 0 };
      let sessionTurnCount = 0;
      /** Spend caps already warned about this session, by window, so each warns once. */
      const warnedSpendCaps = new Set<string>();
      let sessionLimits: SessionLimits =
        appConfig.chat?.defaultCostLimitUSD !== undefined
          ? { maxCostUSD: appConfig.chat.defaultCostLimitUSD }
          : {};
      let autoApprovePolicy: AutoApprovePolicy = SAFE_MODE_POLICY;
      let autoApprovedCommands: string[] = [];
      const autoApprovedTools: string[] = [];
      const sessionStartedAt = new Date();
      let startedAt = sessionStartedAt.toISOString();

      // Load persistent auto-approved commands from config
      if (appConfig.autoApprovedCommands?.length) {
        autoApprovedCommands = [...appConfig.autoApprovedCommands];
      }

      const fileSystem = yield* FileSystem.FileSystem;
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, fileSystem);
      /**
       * What every run this chat starts shares, built fresh per run because the remembered
       * approvals are replaced as the user edits them: the chat's own turns and a goal's cycles
       * run in front of the user both use it, so a cycle behaves like any turn here.
       */
      const chatTurnOptions = (): ChatTurnOptions => ({
        ...(options?.stream !== undefined ? { stream: options.stream } : {}),
        // A getter, so a Shift+Tab switch applies to a run already under way.
        autoApprovePolicy: () => autoApprovePolicy,
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
                Effect.provide(fileSystemLayer),
              ),
            );
          }),
        onAutoApproveTool: (toolName: string) => {
          if (!autoApprovedTools.includes(toolName)) {
            autoApprovedTools.push(toolName);
          }
        },
        checkQueuedMessage: () => {
          const queued = store.takeQueuedProse().join("\n");
          if (queued.length === 0) return undefined;
          Effect.runSync(terminal.user(queued));
          return queued;
        },
        // A Ctrl+B-detached tool call reports back here, possibly long after this run has
        // ended. Queuing it through the same path as text typed mid-run means it surfaces
        // automatically — at the next tool-phase boundary if a run is still going, or as the
        // opening line of the next turn otherwise.
        onDetachedToolComplete: (summary: string) => {
          store.appendToQueue(detachedResultMessage(summary));
        },
      });

      // Load last-used agent from runtime state for sorting /agents and /switch
      const jazzState = yield* JazzStateServiceTag;
      const lastUsedAgentId = yield* jazzState.get("wizard.lastUsedAgentId").pipe(
        Effect.map((value) => (typeof value === "string" ? value : null)),
        Effect.catchAll(() => Effect.succeed(null)),
      );

      // Register mode switch handler for Shift+Tab toggle
      store.registerModeSwitchHandler((mode) => {
        if (chatModeForPolicy(autoApprovePolicy) !== mode) {
          autoApprovePolicy = policyForChatMode(mode);
          store.setModeIsYolo(mode === "yolo");
          const message =
            mode === "yolo"
              ? "🚀 Switched to yolo mode: all tool calls auto-approved"
              : "🛡️ Switched to safe mode: high-risk tool calls require approval";
          store.showModeToast(message);
        }
      });

      // True after a turn ended in a caught error. Decides whether queued
      // text auto-flushes (clean-finish path) or seeds the next prompt for
      // editing (error path).
      let lastTurnErrored = false;

      /** A mistyped command, put back in the composer at the next prompt. */
      let draftToRestore: string | undefined;

      /** The message the session was opened with, sent as its first turn. */
      let firstMessage =
        options?.initialMessage !== undefined && options.initialMessage.trim().length > 0
          ? options.initialMessage
          : undefined;

      // The goal this chat is working toward, and whether its next turn is due. A goal turn is
      // an ordinary turn whose prompt comes from the goal instead of the user.
      let attendedGoalId: string | undefined;
      let goalContinues = false;

      let endReason: ChatSessionEnd["reason"] = "exit";
      let messagesReceived = 0;

      while (chatActive) {
        let userMessage: string | undefined;
        const queued = store.peekQueue();
        // A flush (Esc with queued messages during a run) takes priority over the
        // error path: even though the prior turn was interrupted, the user asked
        // for the queue to go into the chat now, not to be re-edited.
        const flushRequested = store.consumeFlushQueue();

        // What the user typed meanwhile goes first; the goal picks up again after it.
        let goalTurn: Effect.Effect.Success<ReturnType<typeof claimChatGoalTurn>> = undefined;
        if (firstMessage !== undefined) {
          // Typed on home before the session existed: it goes exactly as a typed message would,
          // echoed into the transcript and recallable with ↑.
          userMessage = firstMessage;
          firstMessage = undefined;
          store.pushInputHistory(userMessage);
          yield* terminal.user(userMessage);
        } else if (queued.length === 0 && attendedGoalId !== undefined && goalContinues) {
          goalContinues = false;
          const goalId = attendedGoalId;
          goalTurn = yield* goalLayers(claimChatGoalTurn(goalId)).pipe(
            Effect.catchAll(() => Effect.succeed(undefined)),
          );
          if (goalTurn === undefined) {
            const next = yield* goalLayers(Effect.flatMap(getOwnedGoal(goalId), settledHere)).pipe(
              Effect.catchAll(() => Effect.succeed(undefined)),
            );
            attendedGoalId = next;
            goalContinues = next !== undefined;
            continue;
          }
          yield* announceGoalTurn(goalTurn.goal);
          userMessage = goalTurn.prompt;
        } else if (queued.length > 0 && (!lastTurnErrored || flushRequested)) {
          // Clean prior turn → drain the next queued turn without re-prompting.
          // A command at the head runs alone through the command path below;
          // prose entries are combined. Anything left is picked up next loop.
          // Record entries in input history for ↑ recall parity with
          // interactively typed messages.
          const entries = store.takeQueuedTurn();
          for (const entry of entries) {
            store.pushInputHistory(entry);
          }
          userMessage = entries.join("\n");
          // Echo "You: <prompt>" to scrollback so the user can see when their
          // queued message was actually popped (vs when the LLM started
          // responding to it). The interactive ask() path emits the same
          // echo from terminal.ts on resolve; this path bypasses ask, so we
          // call terminal.user() — the shared helper that owns rendering.
          yield* terminal.user(userMessage);
        } else {
          const draft = queued.length > 0 ? queued : draftToRestore;
          draftToRestore = undefined;
          const askOptions: { commandSuggestions: true; defaultValue?: string } = {
            commandSuggestions: true,
            ...(draft !== undefined ? { defaultValue: draft } : {}),
          };
          yield* emitLifecycle("awaiting-input");
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
              return Effect.fail(toError(error));
            }),
          );
          // Whatever the user submitted supersedes the seeded queue content.
          if (queued.length > 0) {
            store.clearQueue();
          }
        }
        lastTurnErrored = false;

        const input = classifyChatInput(userMessage, terminal.isInteractive);
        const trimmedMessage = (userMessage ?? "").trim();
        if (input.kind === "exit" || input.kind === "end-of-input") {
          endReason = input.kind;
          if (attendedGoalId !== undefined) {
            yield* pauseOnExit(attendedGoalId).pipe(Effect.ignore);
          }
          yield* offerGoalHandoffs().pipe(
            Effect.catchAll((error) =>
              terminal.warn(`Could not hand paused goals to the daemon: ${error.message}`),
            ),
          );
          yield* terminal.log(chalk.dim.italic("— fin —"));

          // Cleanup: Disconnect all MCP servers and unregister mode handler before exiting
          store.registerModeSwitchHandler(null);
          try {
            const mcpManager = yield* MCPServerManagerTag;
            yield* mcpManager.disconnectAllServers().pipe(
              Effect.catchAll(() =>
                Effect.gen(function* () {
                  const logger = yield* LoggerServiceTag;
                  yield* logger.debug("MCP cleanup failed", { errorType: "cleanup_failed" });
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

        if (input.kind === "blank" || userMessage === undefined) {
          if (terminal.isInteractive) {
            yield* terminal.log(
              "(Tip) Type a message and press Enter, '/help' for commands, or '/exit' to quit.",
            );
          }
          continue;
        }
        messagesReceived += 1;

        let messageForAgent = userMessage;
        let trustMessageAsMemorySource = goalTurn === undefined;

        // A message with interior newlines (multi-line composition or a
        // combined prose drain) is prose even when it starts with "/" or "! ":
        // command parsing would silently discard everything after line one.
        if (
          goalTurn === undefined &&
          isCommandInput(trimmedMessage) &&
          (!trimmedMessage.includes("\n") || parseSpecialCommand(trimmedMessage).type === "rename")
        ) {
          const specialCommand = parseSpecialCommand(userMessage);

          // Commands that support pass-through: trailing text is sent as a message to the agent
          const passThroughMessage =
            specialCommand.type === "workflows" && specialCommand.args.length > 0
              ? specialCommand.args.join(" ").trim()
              : null;

          if (specialCommand.type === "prose") {
            // A leading file path (a dragged file) is a message, not a command.
          } else if (passThroughMessage !== null) {
            // Send the trailing text (e.g. "create") as the user message so the agent can guide
            messageForAgent = passThroughMessage;
            // Fall through to agent run below (do not continue)
          } else {
            trustMessageAsMemorySource = false;
            const latestConfig = yield* configService.appConfig;
            const context: CommandContext = {
              agent,
              conversationId,
              conversationTitle,
              ephemeral,
              conversationHistory,
              queuedAfterCommand: store.peekQueue().length > 0,
              sessionUsage,
              sessionTurnCount,
              sessionLimits,
              sessionStartedAt,
              lastUsedAgentId,
              autoApprovePolicy,
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

            if (commandResult.newConversationTitle !== undefined) {
              conversationTitle = commandResult.newConversationTitle;
            }

            // Slash commands are UI interactions, not model turns. Snapshot the rendered
            // text separately so resume restores their invocation and result without
            // inserting operational output into the next LLM request.
            store.flushOutputBatchNow();
            const uiTranscript = uiTranscriptFromStore();
            yield* persistConversationIfNeeded({
              ephemeral,
              conversationHistory,
              conversationId,
              agentId: agent.id,
              startedAt,
              title: conversationTitle,
              uiTranscript,
            });

            if (commandResult.saveCurrentHistory) {
              yield* persistConversationIfNeeded({
                ephemeral,
                conversationHistory,
                conversationId,
                agentId: agent.id,
                startedAt,
                title: conversationTitle,
              });
            }

            if (commandResult.newConversationId !== undefined) {
              // A goal belongs to its conversation; leaving it pauses the goal there.
              if (attendedGoalId !== undefined && commandResult.attendGoal === undefined) {
                yield* pauseOnExit(attendedGoalId).pipe(Effect.ignore);
                attendedGoalId = undefined;
                goalContinues = false;
              }
              conversationId = commandResult.newConversationId;
              conversationTitle = commandResult.newConversationTitle;
              if (!ephemeral) {
                yield* announceWaitingGoals(conversationId).pipe(Effect.ignore);
                yield* announceWaitingLoops(conversationId).pipe(Effect.ignore);
              }
              store.setCurrentConversation({ agentId: agent.id, conversationId });
              reportHerdrSession(conversationId);
              // Logs follow the conversation, so /start starts a new file rather than
              // appending the next conversation to the previous one's.
              yield* logger.setLogGroup(conversationLogGroup(agent.id, conversationId));
              startedAt = new Date().toISOString();
              sessionUsage = { promptTokens: 0, completionTokens: 0 };
              sessionTurnCount = 0;
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
              store.updateRunStats({
                provider: agent.config.llm.provider,
                model: agent.config.llm.model,
                reasoning: reasoningEffortLabel(agent.config.llm.reasoning),
              });
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
              // Most commands that replace the history — /start, /fork, /resume — have to
              // repaint it, or the screen keeps showing turns the agent can no longer see.
              // /compact opts out (skipTranscriptRepaint): it only shrinks the model's
              // context, and the user's scrollback stays as their record of the session.
              if (!commandResult.skipTranscriptRepaint) {
                hydrateTranscriptFromHistory(conversationHistory);
              }
              if (commandResult.resendMessage !== undefined) {
                // /retry replays the SAME conversation — clamp the session-log
                // cursor instead of resetting it (a reset would re-log the
                // entire pre-retry history as duplicate events).
                loggedMessageCount = Math.min(loggedMessageCount, conversationHistory.length);
              } else {
                // Reset logged message count when history is cleared (e.g., /start command)
                loggedMessageCount = 0;
              }
            }
            if (commandResult.resetStartedAt) {
              startedAt = new Date().toISOString();
            }
            if (commandResult.newAutoApprovePolicy !== undefined) {
              autoApprovePolicy = commandResult.newAutoApprovePolicy;
              // Sync mode state with store for Shift+Tab toggle
              store.setModeIsYolo(chatModeForPolicy(autoApprovePolicy) === "yolo");
            }
            if (commandResult.newSessionLimits !== undefined) {
              sessionLimits = commandResult.newSessionLimits;
            }

            if (commandResult.addAutoApprovedCommand) {
              if (!autoApprovedCommands.includes(commandResult.addAutoApprovedCommand)) {
                autoApprovedCommands.push(commandResult.addAutoApprovedCommand);
              }

              yield* Effect.forkDaemon(
                recordCommandApproval(commandResult.addAutoApprovedCommand, conversationId).pipe(
                  Effect.catchAll(() => Effect.void),
                  Effect.provide(fileSystemLayer),
                ),
              );
            }
            if (commandResult.removeAutoApprovedCommand) {
              autoApprovedCommands = autoApprovedCommands.filter(
                (c) => c !== commandResult.removeAutoApprovedCommand,
              );
            }

            if (commandResult.keepDraft === true && terminal.isInteractive) {
              draftToRestore = userMessage;
            }

            if (commandResult.attendGoal !== undefined) {
              attendedGoalId = commandResult.attendGoal;
              goalContinues = true;
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
              if (!commandResult.shouldContinue) {
                chatActive = false;
                store.registerModeSwitchHandler(null);
                const mcpManager = yield* MCPServerManagerTag;
                yield* mcpManager.disconnectAllServers().pipe(Effect.catchAll(() => Effect.void));
              }
              continue;
            }
          }
        }

        if (goalTurn === undefined && messageForAgent === userMessage) {
          const typedMessage = messageForAgent;
          const workingDirectory = yield* (yield* FileSystemContextServiceTag).getCwd({
            agentId: agent.id,
            conversationId,
          });
          const inlined = yield* Effect.tryPromise(() =>
            inlineMentionedTextFiles(typedMessage, workingDirectory),
          ).pipe(Effect.catchAll(() => Effect.succeed({ message: typedMessage, skipped: [] })));
          for (const note of inlined.skipped) {
            yield* terminal.warn(note);
          }
          messageForAgent = inlined.message;
        }

        if (Object.keys(sessionLimits).length > 0) {
          const costUSD = yield* estimateSessionCostUSD(sessionUsage, agent);
          const exceeded = findExceededSessionLimits(sessionLimits, {
            turns: sessionTurnCount,
            costUSD,
            tokens: sessionUsage.promptTokens + sessionUsage.completionTokens,
          });
          if (exceeded.length > 0) {
            const proceed = yield* confirmSessionLimitOverage(terminal, exceeded);
            if (!proceed) {
              yield* terminal.log("Turn cancelled. Use /limit to raise or clear the cap.");
              yield* terminal.log("");
              continue;
            }
          }
        }
        yield* warnWhenSpendCapReached(
          terminal,
          (yield* configService.appConfig).daemon,
          { agentId: agent.id, agentName: agent.name },
          warnedSpendCaps,
        );
        sessionTurnCount += 1;

        yield* Effect.gen(function* () {
          // Set only when the turn fails: its work so far, so "continue" doesn't revert to
          // the pre-turn history.
          let failedTurnMessages: ChatMessage[] | undefined;

          const runnerOptions: AgentRunnerOptions = {
            ...chatTurnOptions(),
            agent,
            userInput: messageForAgent,
            trustUserInputAsMemorySource: trustMessageAsMemorySource,
            conversationId,
            conversationHistory,
            origin: { source: goalTurn === undefined ? "chat" : "goal" },
            onFailedTurn: (messages) => {
              failedTurnMessages = [...messages];
            },
            ...(options?.maxIterations !== undefined
              ? { maxIterations: options.maxIterations }
              : {}),
            ...(ephemeral
              ? { disablePersistence: true }
              : goalTurn === undefined
                ? { offersGoalProposals: true }
                : {}),
            ...(goalTurn !== undefined ? goalTurn.runOptions : {}),
          };

          // Run the agent with proper error handling
          yield* emitLifecycle("user-prompt", { prompt: trimmedMessage.slice(0, 2000) });
          store.setChatBusy(true);
          const turn = AgentRunner.run(runnerOptions);
          // A goal turn is recorded as a run, which is how the goal is charged for it.
          const response = yield* (
            goalTurn === undefined ? turn : turn.pipe(Effect.provide(makeFileRunStoreLayer()))
          ).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                lastTurnErrored = true;
                // Stop the thinking spinner — the agent run failed before
                // streaming started, so nothing else will reset the activity.
                store.setActivity({ phase: "idle" });

                const errorDetails: Record<string, unknown> = {
                  errorType: "agent_execution_failed",
                };
                if (
                  error instanceof LLMRateLimitError ||
                  error instanceof LLMRequestError ||
                  error instanceof LLMAuthenticationError
                ) {
                  errorDetails["errorType"] = error._tag;
                  errorDetails["provider"] = error.provider;
                }

                yield* logger.error("Agent execution error", errorDetails);
                yield* emitLifecycle("run-failed", { error: String(error).slice(0, 2000) });

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
                      `   Cloud models need a key from https://ollama.com/settings/keys. ${apiKeyHint("ollama")} Or run \`ollama signin\` to proxy through a local daemon.`,
                    );
                  } else if (!error.message.includes(apiKeyHint(error.provider))) {
                    // The message already carries the hint when the key was reported missing.
                    yield* terminal.log(`   ${apiKeyHint(error.provider)}`);
                  }
                } else if (error instanceof GenerationInterruptedError) {
                  store.setActivity({ phase: "idle" });
                } else {
                  yield* terminal.error(`Error: ${String(error)}`);
                }
                if (failedTurnMessages !== undefined) {
                  yield* terminal.log(
                    "   The work from this turn is kept: send a message to pick up where it stopped.",
                  );
                }
                yield* terminal.log("");

                // Minimal response so the loop continues; a failed turn hands back its work.
                return {
                  conversationId: conversationId || "",
                  messages: failedTurnMessages ?? conversationHistory,
                  content: "",
                };
              }),
            ),
            Effect.ensuring(Effect.sync(() => store.setChatBusy(false))),
          );

          // Store the conversation ID for continuity
          conversationId = response.conversationId;
          store.setCurrentConversation({ agentId: agent.id, conversationId });

          // A finished turn — the event a task-completion notifier (e.g. Warp) rides.
          if (!lastTurnErrored) {
            yield* emitLifecycle("run-complete", {
              prompt: trimmedMessage.slice(0, 2000),
              summary: (response.content ?? "").slice(0, 2000),
            });
          }

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
              conversationHistory = capChatHistory(conversationHistory);
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

          // A failed turn that kept its work is saved too, so it survives a restart.
          if (
            shouldSaveTurn({
              lastTurnErrored,
              turnKeptFailedWork: failedTurnMessages !== undefined,
            })
          ) {
            yield* persistConversationIfNeeded({
              ephemeral,
              conversationHistory,
              conversationId,
              agentId: agent.id,
              startedAt,
              title: conversationTitle,
              uiTranscript: uiTranscriptFromStore(),
            });
          }

          if (goalTurn !== undefined) {
            const outcome: RunOutcome<AgentResponse> = lastTurnErrored
              ? { kind: "failed", error: "The turn failed." }
              : { kind: "finished", response };
            const claimed = goalTurn;
            const next = yield* goalLayers(
              Effect.flatMap(settleChatGoalTurn(claimed.goal, claimed.runId, outcome), settledHere),
            ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            attendedGoalId = next ?? attendedGoalId;
            goalContinues = next !== undefined;
          } else if (!ephemeral) {
            const accepted = yield* offerProposedGoals(conversationId).pipe(
              Effect.catchAll(() => Effect.succeed(undefined)),
            );
            if (accepted !== undefined) {
              attendedGoalId = accepted;
              goalContinues = true;
            }
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

      yield* emitLifecycle("session-end");
      yield* persistConversationIfNeeded({
        ephemeral,
        conversationHistory,
        conversationId,
        agentId: agent.id,
        startedAt,
        title: conversationTitle,
        uiTranscript: uiTranscriptFromStore(),
      });
      // Stop mirroring state to Herdr once the chat session is over; the
      // exit hooks handle the pane release.
      herdrUnsubscribe?.();

      return { reason: endReason, messagesReceived } satisfies ChatSessionEnd;
    }).pipe(
      Effect.catchAll(() =>
        Effect.succeed<ChatSessionEnd>({ reason: "exit", messagesReceived: 0 }),
      ),
    );
  }
}

/** Snapshot only serializable UI entries; Ink nodes remain a live-renderer concern. */
function uiTranscriptFromStore(): ConversationUiEntry[] {
  store.flushOutputBatchNow();
  return store
    .getOutputSnapshot()
    .entries.flatMap((entry) =>
      typeof entry.message === "string" ? [{ type: entry.type, message: entry.message }] : [],
    );
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
  | AgentConfigService
  | JazzStateService
  | typeof ToolRegistryTag
  | typeof AgentServiceTag
> {
  return Layer.succeed(ChatServiceTag, new ChatServiceImpl());
}

/**
 * Chat never counts toward the `daemon` spend caps and is never stopped by them, but the person
 * is told once per cap and window when one covering this agent is reached: the unattended work
 * it covers refuses to start until then (see `run-accounting.ts`).
 */
function warnWhenSpendCapReached(
  terminal: TerminalService,
  caps: DaemonConfig | undefined,
  agent: { readonly agentId: string; readonly agentName: string },
  warned: Set<string>,
) {
  return Effect.gen(function* () {
    const now = Date.now();
    const check = yield* checkSpendCaps(caps, { ...agent, source: "chat" }, { now }).pipe(
      Effect.catchAll(() => Effect.succeed<CapCheck>({ kind: "clear" })),
    );
    if (check.kind === "clear") {
      return;
    }
    const key = capWindowKey(check, { day: localDayKey(now), monthKey: localMonthKey(now) });
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    yield* terminal.warn(
      `${describeCapCheck(check)} Chat is not capped; the unattended work it covers waits.`,
    );
  });
}
