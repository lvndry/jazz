import { listOwnedGoals, pendingGoalInput } from "@jazz/adapters/goals/goal-actions";
import {
  loadConversationOrNull,
  loadHistory,
} from "@jazz/adapters/history/conversation-history-service";
import { loopsWaitingOnUser, pendingLoopInput } from "@jazz/adapters/loops/loop-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileLoopStoreLayer } from "@jazz/adapters/storage/loop-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { sortAgents } from "@jazz/core/agent/agent-sort";
import { WAITING_ON_USER_GOAL_STATES } from "@jazz/core/agent/goal/goal-state";
import { isLocalServerProvider, isZeroCostLocalModel } from "@jazz/core/constants/local-providers";
import { isOllamaCloudModel } from "@jazz/core/constants/ollama";
import { LLM_PROVIDER_ENV_VARS, llmProviderEnvVars } from "@jazz/core/constants/provider-env-vars";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { ChatServiceTag } from "@jazz/core/interfaces/chat-service";
import { JazzStateServiceTag } from "@jazz/core/interfaces/jazz-state";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent, AppConfig } from "@jazz/core/types/index";
import type { ChatMessage } from "@jazz/core/types/message";
import { toError } from "@jazz/core/utils/errors";
import { isRecord } from "@jazz/core/utils/is-record";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { agentModelString, formatProviderDisplayName } from "@jazz/core/utils/provider-model";
import { Effect } from "effect";
import { goalHandle, goalStatus } from "@/cli/goals/describe-goal";
import { requireInteractiveTerminal } from "@/cli/helpers/interactive-terminal";
import { loopStatus } from "@/cli/loops/describe-loop";
import { agentDetailFields } from "./agent-details";
import { deleteAgentCommand } from "./agent-management";
import { configWizardCommand } from "./config-wizard";
import { createAgentCommand } from "./create-agent";
import { editAgentCommand } from "./edit-agent";
import { environmentKeyDetections, ollamaOrigin, probeOllamaModels } from "./home-detection";
import {
  buildHome,
  homeActions,
  homeConversations,
  homeStatus,
  parseOpenConversationValue,
  type HomeConversationSource,
} from "./home-surface";
import { sessionOpenLine } from "./session-open";
import { configuredProviderNames } from "../ui/fullscreen/home-readiness";
import { store, type ActiveAgentChoice, type ActiveHomeDetection } from "../ui/store";

/**
 * Wizard menu option identifiers
 */
/**
 * Interactive wizard command - the main entry point when `jazz` is run with no arguments
 */
export function wizardCommand() {
  return requireInteractiveTerminal(
    "jazz",
    'Run `jazz` in a terminal. From a script, use `jazz run --agent <id> "<prompt>"`, or pipe messages to `jazz agent chat <agent>`, one per line.',
  ).pipe(Effect.zipRight(wizardSession()));
}

/** The home menu loop, once a terminal that can prompt is known to be present. */
function wizardSession() {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const terminal = yield* TerminalServiceTag;

    // Set terminal tab title
    yield* terminal.setTitle("🎷 Jazz");

    yield* promptNotificationsOnFirstRun(configService, terminal);

    // Main wizard loop - keeps running until user exits
    let shouldExit = false;

    while (!shouldExit) {
      const agents = yield* agentService.listAgents();

      // Last used agent, from runtime state: it is the agent enter starts a conversation with.
      const jazzState = yield* JazzStateServiceTag;
      const lastUsedAgentId = yield* jazzState.get("wizard.lastUsedAgentId").pipe(
        Effect.map((value) => (typeof value === "string" ? value : null)),
        Effect.catchAll(() => Effect.succeed(null)),
      );
      const defaultAgent = sortAgents(agents, lastUsedAgentId)[0];
      const appConfig = yield* configService.appConfig;
      const providerCount = configuredProviderNames(appConfig).length;

      const selection = yield* showHome({
        agents,
        defaultAgent,
        providerCount,
        firstRunDetections:
          agents.length === 0 ? firstRunDetections(appConfig) : Effect.succeed(undefined),
      });

      // Handle the selected action
      switch (selection) {
        case "resume-conversation": {
          yield* resumeConversation(agents, terminal);
          yield* terminal.clear();
          break;
        }

        case "new-conversation": {
          if (defaultAgent !== undefined) {
            yield* startChatWithAgent(defaultAgent);
            yield* terminal.clear();
          }
          break;
        }

        case "pick-agent": {
          const selectedAgent = yield* selectAgent(
            agents,
            lastUsedAgentId,
            "pick an agent",
            "start",
          );
          if (selectedAgent) {
            yield* startChatWithAgent(selectedAgent);
            yield* terminal.clear();
          }
          break;
        }

        case "create-agent":
        case "create-agent:ollama": {
          // Track agent count before creation to detect if agent was actually created
          const agentCountBefore = agents.length;

          // Run create agent flow and start chat with newly created agent
          const creationResult = yield* createAgentCommand(
            selection === "create-agent:ollama" ? { initialProvider: "ollama" } : {},
          ).pipe(Effect.either);

          if (creationResult._tag === "Left") {
            // Creation failed
            yield* terminal.error(`Failed to create agent: ${String(creationResult.left)}`);
            break;
          }

          // Fetch agents after creation and pick the most recently created one
          const agentsAfterCreate = yield* agentService.listAgents().pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* terminal.error(`Failed to retrieve agents: ${String(error)}`);
                return [] as Agent[];
              }),
            ),
          );

          // Only start chat if a new agent was actually created
          if (agentsAfterCreate.length === 0 || agentsAfterCreate.length <= agentCountBefore) {
            yield* terminal.clear();
            break;
          }

          // Find newest agent by createdAt timestamp
          const newest = agentsAfterCreate.reduce((prev, curr) =>
            prev.createdAt.getTime() > curr.createdAt.getTime() ? prev : curr,
          );

          // Start chat with the newly created agent
          yield* startChatWithAgent(newest).pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* terminal.error(`Failed to start chat with created agent: ${String(error)}`);
              }),
            ),
          );

          yield* terminal.clear();
          break;
        }

        case "edit-agent": {
          const selectedAgent = yield* selectAgent(
            agents,
            lastUsedAgentId,
            "edit an agent",
            "edit",
          );
          if (selectedAgent) {
            yield* editAgentCommand(selectedAgent.id).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  yield* terminal.error(`Failed to edit agent: ${String(error)}`);
                }),
              ),
            );
            yield* terminal.clear();
          }
          break;
        }

        case "list-agents": {
          const listedAgents = yield* agentService.listAgents().pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* terminal.error(`Failed to list agents: ${String(error)}`);
                return [] as Agent[];
              }),
            ),
          );
          let previouslyOpenedId: string | undefined;
          while (true) {
            const selectedAgent = yield* showAgentList(
              listedAgents,
              lastUsedAgentId,
              previouslyOpenedId,
            );
            if (selectedAgent === null) break;
            previouslyOpenedId = selectedAgent.id;
            const metadata = isZeroCostLocalModel(
              selectedAgent.config.llmProvider,
              selectedAgent.config.llmModel,
            )
              ? undefined
              : yield* Effect.tryPromise({
                  try: () =>
                    getModelsDevMetadata(
                      selectedAgent.config.llmModel,
                      selectedAgent.config.llmProvider,
                    ),
                  catch: (error) => error,
                }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            const llmService = yield* LLMServiceTag;
            const appConfig = yield* configService.appConfig;
            const hostUrl =
              isLocalServerProvider(selectedAgent.config.llmProvider) &&
              (selectedAgent.config.llmProvider !== "ollama" ||
                !isOllamaCloudModel(selectedAgent.config.llmModel))
                ? llmService.resolveLocalProviderBaseUrl(
                    selectedAgent.config.llmProvider,
                    appConfig.llm,
                  )
                : undefined;
            yield* showAgentDetails(selectedAgent, metadata, hostUrl);
          }
          break;
        }

        case "delete-agent": {
          const selectedAgent = yield* selectAgent(
            agents,
            lastUsedAgentId,
            "delete an agent",
            "delete",
          );
          if (selectedAgent) {
            // Deletion is irreversible — always confirm, defaulting to No.
            const confirmed = yield* terminal.confirm(
              `Delete agent "${selectedAgent.name}" (${selectedAgent.config.llmProvider}/${selectedAgent.config.llmModel})? This cannot be undone.`,
              false,
            );
            if (!confirmed) {
              yield* terminal.info("Deletion cancelled.");
              yield* terminal.clear();
              break;
            }
            yield* deleteAgentCommand(selectedAgent.id, { skipConfirmation: true }).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  yield* terminal.error(`Failed to delete agent: ${String(error)}`);
                }),
              ),
            );
            yield* terminal.clear();
          }
          break;
        }

        case "config": {
          yield* configWizardCommand();
          yield* terminal.clear();
          break;
        }

        case "exit":
          shouldExit = true;
          break;

        default: {
          const opened = parseOpenConversationValue(selection);
          const agent =
            opened === null
              ? undefined
              : agents.find((candidate) => candidate.id === opened.agentId);
          if (opened === null || agent === undefined) {
            shouldExit = true;
            break;
          }
          yield* openConversation(agent, opened.conversationId);
          yield* terminal.clear();
          break;
        }
      }
    }

    yield* terminal.log("");
    yield* Effect.sync(() => process.exit(0));
  }).pipe(Effect.catchAll((error) => Effect.fail(toError(error))));
}

/** Everything the home loop needs to know about the agents before it shows the screen. */
interface HomeContext {
  readonly agents: readonly Agent[];
  readonly defaultAgent: Agent | undefined;
  readonly providerCount: number;
  /** Only computed on first run, where a key in the environment or a local Ollama is a fast path. */
  readonly firstRunDetections: Effect.Effect<FirstRunDetections | undefined, never, never>;
}

interface FirstRunDetections {
  readonly detected: readonly ActiveHomeDetection[];
  readonly ollamaModels: number | undefined;
}

/** A key exported in the environment, and a local Ollama if one answers quickly. */
function firstRunDetections(
  appConfig: AppConfig,
): Effect.Effect<FirstRunDetections | undefined, never, never> {
  return Effect.promise(async () => {
    const ollamaConfig: unknown = (appConfig.llm as Record<string, unknown> | undefined)?.[
      "ollama"
    ];
    const baseUrl =
      isRecord(ollamaConfig) && typeof ollamaConfig["base_url"] === "string"
        ? ollamaConfig["base_url"]
        : undefined;
    const ollamaModels = await probeOllamaModels(ollamaOrigin(baseUrl));
    const detected: ActiveHomeDetection[] = environmentKeyDetections();
    if (ollamaModels !== undefined && ollamaModels > 0) {
      detected.push({
        label: "Ollama",
        detail: `running on this machine with ${String(ollamaModels)} ${ollamaModels === 1 ? "model" : "models"}`,
      });
    }
    return { detected, ollamaModels };
  });
}

/** Saved conversations across every agent, as the home screen lists them. */
function conversationSources(agents: readonly Agent[]) {
  return Effect.gen(function* () {
    const sources: HomeConversationSource[] = [];
    for (const agent of agents) {
      const history = yield* loadHistory(agent.id).pipe(
        Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
      );
      for (const conversation of history.conversations) {
        sources.push({
          agentId: agent.id,
          agentName: agent.name,
          conversationId: conversation.conversationId,
          title: conversation.title,
          startedAt: conversation.startedAt,
          endedAt: conversation.endedAt,
          messageCount: conversation.messageCount,
        });
      }
    }
    return sources;
  });
}

/**
 * Show home and return what was picked.
 *
 * The screen goes up as soon as the agent list is known, then fills in the conversations once
 * the history has loaded. Every action is addressed by key, and each key the first frame shows
 * is still there in the second, so a key pressed while the history loads does what the screen
 * said it would.
 */
function showHome(context: HomeContext) {
  return Effect.gen(function* () {
    const now = new Date();
    const firstRun = context.agents.length === 0;
    const status = homeStatus({
      agentCount: context.agents.length,
      providerCount: context.providerCount,
    });
    const actionsFor = (hasHistory: boolean, ollamaModels?: number) =>
      homeActions({
        agentCount: context.agents.length,
        defaultAgentName: context.defaultAgent?.name,
        hasHistory,
        ...(ollamaModels === undefined ? {} : { ollamaModels }),
      });

    let answer: ((value: string) => void) | undefined;
    const answered = new Promise<string>((resolve) => {
      answer = resolve;
    });
    // Before the history loads, resume is offered whenever there are agents, so the key stays
    // put when the conversations arrive; resuming with nothing saved says so plainly.
    store.setActiveMenu(
      buildHome({ now, conversations: [], actions: actionsFor(!firstRun), status, firstRun }),
      (result) => answer?.(result.kind === "exit" ? "exit" : result.value),
    );

    if (firstRun) {
      const detections = yield* context.firstRunDetections;
      store.refreshActiveMenu(
        buildHome({
          now,
          conversations: [],
          actions: actionsFor(false, detections?.ollamaModels),
          status,
          ...(detections === undefined ? {} : { detected: detections.detected }),
          firstRun,
        }),
      );
    } else {
      const sources = yield* conversationSources(context.agents);
      const waiting =
        sources.length === 0 ? new Map<string, string>() : yield* waitingConversations();
      store.refreshActiveMenu(
        buildHome({
          now,
          conversations: homeConversations(sources, waiting, now.getTime()),
          actions: actionsFor(true),
          status,
          firstRun,
        }),
      );
    }

    return yield* Effect.promise(() => answered);
  });
}

function agentChoicesFor(
  agents: readonly Agent[],
  lastUsedAgentId: string | null | undefined,
): readonly ActiveAgentChoice[] {
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    model: agentModelString(agent.config),
    persona: agent.config.persona,
    ...(agent.description !== undefined && agent.description !== agent.name
      ? { description: agent.description }
      : {}),
    ...(agent.id === lastUsedAgentId ? { lastUsed: true as const } : {}),
  }));
}

export function showAgentList(
  agents: readonly Agent[],
  lastUsedAgentId: string | null | undefined,
  previouslyOpenedId?: string,
): Effect.Effect<Agent | null, never, never> {
  return Effect.async<Agent | null>((resume) => {
    const sorted = sortAgents(agents, lastUsedAgentId);
    store.setActiveMenu(
      {
        kind: "agents",
        title: "agents",
        action: "details",
        agents: agentChoicesFor(sorted, lastUsedAgentId),
        ...(previouslyOpenedId === undefined
          ? {}
          : {
              initialIndex: Math.max(
                0,
                sorted.findIndex((agent) => agent.id === previouslyOpenedId),
              ),
            }),
      },
      (result) => {
        resume(
          Effect.succeed(
            result.kind === "exit"
              ? null
              : (agents.find((agent) => agent.id === result.value) ?? null),
          ),
        );
      },
    );
  });
}

/** Display one selected agent until the reader returns to the list. */
function showAgentDetails(
  agent: Agent,
  metadata: Awaited<ReturnType<typeof getModelsDevMetadata>>,
  hostUrl: string | undefined,
): Effect.Effect<void, never, never> {
  return Effect.async<void>((resume) => {
    store.setActiveMenu(
      {
        kind: "agent-details",
        name: agent.name,
        fields: agentDetailFields(agent, metadata, hostUrl),
      },
      () => resume(Effect.void),
    );
  });
}

/**
 * Show agent selection menu
 */
function selectAgent(
  agents: readonly Agent[],
  lastUsedAgentId: string | null | undefined,
  title: string,
  action: string,
): Effect.Effect<Agent | null, never, never> {
  return Effect.async<Agent | null>((resume) => {
    const sorted = sortAgents(agents, lastUsedAgentId);
    store.setActiveMenu(
      {
        kind: "agents",
        title,
        action,
        agents: agentChoicesFor(sorted, lastUsedAgentId),
      },
      (result) => {
        resume(
          Effect.succeed(
            result.kind === "exit"
              ? null
              : (agents.find((agent) => agent.id === result.value) ?? null),
          ),
        );
      },
    );
  });
}

/**
 * Start a chat session with an agent and save as last used
 */
function startChatWithAgent(
  agent: Agent,
  options?: {
    initialHistory?: ChatMessage[];
    initialUiTranscript?: readonly import("@jazz/adapters/history/conversation-history-service").ConversationUiEntry[];
  },
) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const jazzState = yield* JazzStateServiceTag;

    yield* jazzState
      .set("wizard.lastUsedAgentId", agent.id)
      .pipe(
        Effect.catchAll((error) =>
          terminal.warn(
            `Could not remember ${agent.name} as the last used agent: ${error.message}`,
          ),
        ),
      );

    yield* terminal.clear();
    yield* terminal.log(sessionOpenLine(agent));

    // Start the chat session
    const chatService = yield* ChatServiceTag;
    yield* chatService.startChatSession(agent, options).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Chat session error: ${String(error)}`);
        }),
      ),
    );
  });
}

const MAX_RESUME_CHOICES = 50;

/**
 * Load all saved conversations across agents, show a selector, and resume the chosen one
 */
/**
 * Conversations with a goal or loop that can go no further until the user acts, each with what
 * it waits on in words, so the resume list can say which conversation needs them and why.
 */
function waitingConversations() {
  return Effect.gen(function* () {
    const waiting = new Map<string, string>();
    const goals = yield* listOwnedGoals({ states: WAITING_ON_USER_GOAL_STATES });
    for (const goal of goals) {
      if (goal.sourceConversationId !== undefined) {
        const pending = yield* pendingGoalInput(goal);
        waiting.set(
          goal.sourceConversationId,
          `goal ${goalHandle(goal)} ${goalStatus(goal, pending)}`,
        );
      }
    }
    for (const loop of yield* loopsWaitingOnUser()) {
      if (loop.sourceConversationId !== undefined && !waiting.has(loop.sourceConversationId)) {
        const pending = yield* pendingLoopInput(loop);
        waiting.set(loop.sourceConversationId, `loop ${loop.name} ${loopStatus(loop, pending)}`);
      }
    }
    return waiting;
  }).pipe(
    Effect.provide(makeFileGoalStoreLayer()),
    Effect.provide(makeFileLoopStoreLayer()),
    Effect.provide(makeFileRunStoreLayer()),
    Effect.catchAll(() => Effect.succeed(new Map<string, string>())),
  );
}

function resumeConversation(agents: readonly Agent[], terminal: TerminalService) {
  return Effect.gen(function* () {
    const waiting = yield* waitingConversations();
    type ConversationEntry = {
      agent: Agent;
      conversationId: string;
      title: string;
      startedAt: string;
      messageCount: number;
    };
    const entries: ConversationEntry[] = [];

    for (const agent of agents) {
      const history = yield* loadHistory(agent.id).pipe(
        Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
      );
      for (const conv of history.conversations) {
        entries.push({
          agent,
          conversationId: conv.conversationId,
          title: conv.title,
          startedAt: conv.startedAt,
          messageCount: conv.messageCount,
        });
      }
    }

    if (entries.length === 0) {
      yield* terminal.warn("No saved conversations found.");
      return;
    }

    // Waiting conversations first, so the one the menu counted is the one on top.
    entries.sort(
      (a, b) =>
        Number(waiting.has(b.conversationId)) - Number(waiting.has(a.conversationId)) ||
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    entries.splice(MAX_RESUME_CHOICES);

    const choices = entries.map((entry, idx) => {
      const waitingOn = waiting.get(entry.conversationId);
      return {
        name: `${waitingOn !== undefined ? "● " : ""}${entry.title} · ${agentModelString(entry.agent.config)}`,
        ...(waitingOn !== undefined ? { description: `waiting for you: ${waitingOn}` } : {}),
        value: String(idx),
      };
    });

    const selectedIdx = yield* terminal.search<string>("Select a conversation to resume:", {
      choices,
      placeholder: "Type to filter conversations…",
    });
    if (selectedIdx === null || selectedIdx === undefined) return;

    const selected = entries[Number(selectedIdx)];
    if (!selected) return;

    yield* openConversation(selected.agent, selected.conversationId);
  });
}

/**
 * Continue one saved conversation. Its messages are read here, on demand: pickers need titles
 * and dates, not transcripts, so the chosen conversation is the only one ever loaded.
 */
function openConversation(agent: Agent, conversationId: string) {
  return Effect.gen(function* () {
    const conversation = yield* loadConversationOrNull(agent.id, conversationId);
    yield* startChatWithAgent(agent, {
      initialHistory: conversation?.messages ?? [],
      ...(conversation?.uiTranscript !== undefined
        ? { initialUiTranscript: conversation.uiTranscript }
        : {}),
    });
  });
}

/**
 * Check if this is the first run and prompt for notification preferences
 */
function promptNotificationsOnFirstRun(
  configService: AgentConfigService,
  terminal: TerminalService,
) {
  return Effect.gen(function* () {
    // Check if notifications have ever been configured
    const hasNotificationsConfigured = yield* configService.has("notifications.enabled");

    if (hasNotificationsConfigured) {
      return; // Already configured, skip prompt
    }

    // First run - welcome and setup
    yield* terminal.log("");
    yield* terminal.heading("🎷 Welcome to Jazz! Let's get you set up.");
    yield* terminal.log("");

    const detectedProviders: string[] = [];
    for (const provider of Object.keys(LLM_PROVIDER_ENV_VARS)) {
      const envVar = llmProviderEnvVars(provider).find((name) => process.env[name]?.trim());
      if (envVar !== undefined) {
        detectedProviders.push(`${formatProviderDisplayName(provider)} (${envVar})`);
      }
    }
    if (detectedProviders.length > 0) {
      yield* terminal.success("Detected API keys from environment:");
      for (const p of detectedProviders) {
        yield* terminal.log(`   • ${p}`);
      }
      yield* terminal.log("");
    } else {
      yield* terminal.info("No API keys detected from environment.");
      yield* terminal.log("  Set up a key via 'Update configuration' or export OPENAI_API_KEY");
      yield* terminal.log("");
    }

    // Ask about notifications
    yield* terminal.info("Jazz can send desktop notifications for completions and approvals.");
    const enableNotifications = yield* terminal.confirm(
      "Enable desktop notifications?",
      true, // Default to yes
    );

    if (enableNotifications === undefined) {
      yield* terminal.info("Skipped. Configure notifications anytime in Settings.");
      yield* terminal.log("");
      return;
    }

    yield* configService.set("notifications.enabled", enableNotifications);

    if (enableNotifications) {
      const enableSound = yield* terminal.confirm("Play a sound with notifications?", true);
      if (enableSound !== undefined) {
        yield* configService.set("notifications.sound", enableSound);
      }
      yield* terminal.success("Notifications enabled! Change anytime in Settings.");
    } else {
      yield* terminal.info("Notifications disabled. Enable anytime in Settings.");
    }

    yield* terminal.log("");
  });
}
