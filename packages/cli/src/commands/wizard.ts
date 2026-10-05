import { controlGoal, listOwnedGoals, pendingGoalInput } from "@jazz/adapters/goals/goal-actions";
import { loadConversation, loadHistory } from "@jazz/adapters/history/conversation-history-service";
import { formatRelativeWhen } from "@jazz/adapters/history/conversation-search";
import { loopsWaitingOnUser, pendingLoopInput } from "@jazz/adapters/loops/loop-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileLoopStoreLayer } from "@jazz/adapters/storage/loop-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { sortAgents } from "@jazz/core/agent/agent-sort";
import { WAITING_ON_USER_GOAL_STATES } from "@jazz/core/agent/goal/goal-state";
import { LLM_PROVIDER_ENV_VARS, llmProviderEnvVars } from "@jazz/core/constants/provider-env-vars";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { ChatServiceTag } from "@jazz/core/interfaces/chat-service";
import { JazzStateServiceTag } from "@jazz/core/interfaces/jazz-state";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent, AppConfig } from "@jazz/core/types/index";
import type { ChatMessage } from "@jazz/core/types/message";
import { toError } from "@jazz/core/utils/errors";
import { isRecord } from "@jazz/core/utils/is-record";
import { agentModelString, formatProviderDisplayName } from "@jazz/core/utils/provider-model";
import { Effect } from "effect";
import { requireInteractiveTerminal } from "@/cli/helpers/interactive-terminal";
import {
  agentChoicesFor,
  confirmAndDeleteAgent,
  localHostUrlFor,
  modelMetadataFor,
  showAgentActions,
  showAgentDetails,
  showAgentList,
} from "./agent-menu";
/** Re-exported for existing tests; the menu lives in agent-menu.ts. */
export { showAgentList };
import { createAgentCommand } from "./create-agent";
import { editAgentCommand } from "./edit-agent";
import { buildHome } from "./home-surface";
import { sessionOpenLine } from "./session-open";
import { settingsWizardCommand } from "./settings-wizard";
import {
  environmentKeyDetections,
  ollamaOrigin,
  probeOllamaModels,
} from "../helpers/provider-detection";
import { configuredProviderNames } from "../ui/models/configured-providers";
import {
  PICK_AGENT,
  START_COMMAND,
  briefDetail,
  parseOpenConversationValue,
  readableTitle,
  waitingTag,
  startedAgentId,
  type AgentUsage,
  type WaitingSource,
} from "../ui/models/home-view";
import { store, type ActiveHomeDetection } from "../ui/store";

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

    let shouldExit = false;
    // The agent chosen in the full picker, and what was typed before opening it, so home comes
    // back as it was left.
    let targetAgentId: string | undefined;
    let draft: string | undefined;

    while (!shouldExit) {
      const agents = yield* agentService.listAgents();
      const jazzState = yield* JazzStateServiceTag;
      const lastUsedAgentId = yield* jazzState.get("wizard.lastUsedAgentId").pipe(
        Effect.map((value) => (typeof value === "string" ? value : null)),
        Effect.catchAll(() => Effect.succeed(null)),
      );
      const appConfig = yield* configService.appConfig;
      const providerCount = configuredProviderNames(appConfig).length;

      const answer = yield* showHome({
        agents,
        lastUsedAgentId,
        targetAgentId,
        draft,
        providerCount,
        appConfig,
      });
      const selection = answer.value;
      targetAgentId = undefined;
      draft = undefined;

      // Handle the selected action
      switch (selection) {
        case "resume-conversation": {
          yield* resumeConversation(agents, terminal);
          yield* terminal.clear();
          break;
        }

        case START_COMMAND: {
          const picked = yield* selectAgent(
            agents,
            lastUsedAgentId,
            "start with which agent?",
            "start",
          );
          if (picked !== null) {
            yield* startChatWithAgent(picked);
            yield* terminal.clear();
          }
          break;
        }

        case PICK_AGENT: {
          const picked = yield* selectAgent(agents, lastUsedAgentId, "pick an agent", "choose");
          targetAgentId = picked?.id ?? answer.targetAgentId;
          draft = answer.text;
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

        case "list-agents": {
          let listedAgents = yield* agentService.listAgents().pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* terminal.error(`Could not read your agents: ${String(error)}`);
                return [] as Agent[];
              }),
            ),
          );
          let previouslyOpenedId: string | undefined;
          let started = false;
          while (!started && listedAgents.length > 0) {
            const selectedAgent = yield* showAgentList(
              listedAgents,
              lastUsedAgentId,
              previouslyOpenedId,
            );
            if (selectedAgent === null) break;
            previouslyOpenedId = selectedAgent.id;
            const action = yield* showAgentActions(selectedAgent);
            switch (action) {
              case "start":
                yield* startChatWithAgent(selectedAgent);
                yield* terminal.clear();
                started = true;
                break;
              case "details":
                yield* showAgentDetails(
                  selectedAgent,
                  yield* modelMetadataFor(selectedAgent),
                  yield* localHostUrlFor(selectedAgent),
                );
                break;
              case "edit":
                yield* editAgentCommand(selectedAgent.id).pipe(
                  Effect.catchAll((error) =>
                    terminal.error(`${selectedAgent.name} was not changed: ${String(error)}`),
                  ),
                );
                yield* terminal.clear();
                listedAgents = yield* agentService
                  .listAgents()
                  .pipe(Effect.catchAll(() => Effect.succeed(listedAgents)));
                break;
              case "delete": {
                const deleted = yield* confirmAndDeleteAgent(selectedAgent);
                if (deleted) {
                  listedAgents = listedAgents.filter((agent) => agent.id !== selectedAgent.id);
                  previouslyOpenedId = undefined;
                }
                break;
              }
              case "back":
                break;
            }
          }
          break;
        }

        case "settings": {
          yield* settingsWizardCommand();
          yield* terminal.clear();
          break;
        }

        case "exit":
          shouldExit = true;
          break;

        default: {
          const startedId = startedAgentId(selection);
          if (startedId !== undefined) {
            const agent = agents.find((candidate) => candidate.id === startedId);
            if (agent !== undefined) {
              const message = answer.text?.trim() ?? "";
              yield* startChatWithAgent(
                agent,
                message.length > 0 ? { initialMessage: message } : {},
              );
              yield* terminal.clear();
            }
            break;
          }
          const opened = parseOpenConversationValue(selection);
          const agent =
            opened === null
              ? undefined
              : agents.find((candidate) => candidate.id === opened.agentId);
          if (opened === null || agent === undefined) {
            shouldExit = true;
            break;
          }
          if (yield* openConversation(agent, opened.conversationId)) {
            yield* terminal.clear();
          }
          break;
        }
      }
    }

    yield* terminal.log("");
    yield* Effect.sync(() => process.exit(0));
  }).pipe(Effect.catchAll((error) => Effect.fail(toError(error))));
}

/** Everything home needs before it goes up. */
interface HomeContext {
  readonly agents: readonly Agent[];
  readonly lastUsedAgentId: string | null;
  readonly targetAgentId: string | undefined;
  readonly draft: string | undefined;
  readonly providerCount: number;
  readonly appConfig: AppConfig;
}

/** What home answered: the value, what was typed, and the agent chosen when it was answered. */
interface HomeAnswer {
  readonly value: string;
  readonly text?: string;
  readonly targetAgentId?: string;
}

/** A key exported in the environment, and a local Ollama if one answers quickly. */
function firstRunDetections(appConfig: AppConfig) {
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

/** When each agent was last in a conversation, and each conversation's saved title. */
function conversationActivity(agents: readonly Agent[]) {
  return Effect.gen(function* () {
    const lastUsedMs = new Map<string, number>();
    const titles = new Map<string, string>();
    for (const agent of agents) {
      const history = yield* loadHistory(agent.id).pipe(
        Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
      );
      for (const conversation of history.conversations) {
        titles.set(conversation.conversationId, conversation.title);
        const at = new Date(conversation.lastMessageAt ?? conversation.startedAt).getTime();
        if (Number.isFinite(at) && at > (lastUsedMs.get(agent.id) ?? -1)) {
          lastUsedMs.set(agent.id, at);
        }
      }
    }
    return { lastUsedMs, titles };
  });
}

function agentUsage(
  agents: readonly Agent[],
  lastUsedMs: ReadonlyMap<string, number>,
): AgentUsage[] {
  return agents.map((agent) => {
    const used = lastUsedMs.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      model: agentModelString(agent.config.llm),
      persona: agent.config.persona,
      ...(used === undefined ? {} : { lastUsedMs: used }),
    };
  });
}

/**
 * Goals and loops blocked on the user, as home's waiting section. Each is titled from its name,
 * what it was asked to do, or its conversation's first message, and says what it needs.
 */
function waitingWork(agents: readonly Agent[], titles: ReadonlyMap<string, string>, nowMs: number) {
  return Effect.gen(function* () {
    const agentName = (id: string): string =>
      agents.find((agent) => agent.id === id)?.name ?? "an agent";
    const age = (iso: string): string => formatRelativeWhen(new Date(iso).getTime(), nowMs);
    const work: WaitingSource[] = [];
    const seen = new Set<string>();
    for (const goal of yield* listOwnedGoals({ states: WAITING_ON_USER_GOAL_STATES })) {
      const conversationId = goal.sourceConversationId;
      if (conversationId === undefined || seen.has(conversationId)) {
        continue;
      }
      seen.add(conversationId);
      const pending = yield* pendingGoalInput(goal);
      const state = goal.state;
      const reason =
        state.kind === "review-required"
          ? state.question === undefined
            ? "review"
            : "question"
          : pending?.kind === "question" ||
              (state.kind === "awaiting-input" && state.reason === "question")
            ? "question"
            : state.kind === "proposed"
              ? "review"
              : "approval";
      const detail =
        pending?.described ??
        (state.kind === "review-required" ? (state.question ?? state.reason) : undefined) ??
        (state.kind === "proposed" ? "Accept the plan to start it." : undefined);
      const conversationTitle = titles.get(conversationId);
      work.push({
        agentId: goal.agentId,
        agentName: agentName(goal.agentId),
        conversationId,
        goalId: goal.goalId,
        reason,
        age: age(goal.updatedAt),
        objective: goal.plan.objective,
        ...(goal.name === undefined ? {} : { workName: goal.name }),
        ...(conversationTitle === undefined ? {} : { conversationTitle }),
        ...(detail === undefined ? {} : { detail }),
      });
    }
    for (const loop of yield* loopsWaitingOnUser()) {
      const conversationId = loop.sourceConversationId;
      if (conversationId === undefined || seen.has(conversationId)) {
        continue;
      }
      seen.add(conversationId);
      const pending = yield* pendingLoopInput(loop);
      const conversationTitle = titles.get(conversationId);
      work.push({
        agentId: loop.agentId,
        agentName: agentName(loop.agentId),
        conversationId,
        reason:
          pending === undefined ? "stopped" : pending.kind === "question" ? "question" : "approval",
        age: age(loop.updatedAt),
        workName: loop.name,
        objective: loop.prompt,
        ...(conversationTitle === undefined ? {} : { conversationTitle }),
        ...(pending !== undefined
          ? { detail: pending.described }
          : loop.state.kind === "failed"
            ? { detail: loop.state.reason }
            : {}),
      });
    }
    return work;
  }).pipe(
    Effect.provide(makeFileGoalStoreLayer()),
    Effect.provide(makeFileLoopStoreLayer()),
    Effect.provide(makeFileRunStoreLayer()),
    Effect.catchAll(() => Effect.succeed([] as WaitingSource[])),
  );
}

/**
 * Show home and return what was picked.
 *
 * The screen goes up as soon as the agent list is known and fills in when the history has
 * loaded: when each agent was last used, and what is waiting. The target agent is fixed before
 * the first frame (the one picked in the full picker, else the last used), so the button never
 * changes under a key already pressed.
 */
function showHome(context: HomeContext) {
  return Effect.gen(function* () {
    const nowMs = Date.now();
    const firstRun = context.agents.length === 0;
    const target =
      context.targetAgentId ??
      (context.lastUsedAgentId !== null &&
      context.agents.some((agent) => agent.id === context.lastUsedAgentId)
        ? context.lastUsedAgentId
        : undefined);
    const base = {
      shownAt: nowMs,
      lastUsedAgentId: context.lastUsedAgentId,
      targetAgentId: target,
      draft: context.draft,
      providerCount: context.providerCount,
    };

    let answer: ((value: HomeAnswer) => void) | undefined;
    const answered = new Promise<HomeAnswer>((resolve) => {
      answer = resolve;
    });
    store.setActiveMenu(
      buildHome({
        ...base,
        agents: agentUsage(context.agents, new Map()),
        lastUsedWords: new Map(),
        waiting: [],
      }),
      (result) =>
        answer?.(
          result.kind === "exit"
            ? { value: "exit" }
            : {
                value: result.value,
                ...(result.text === undefined ? {} : { text: result.text }),
                ...(target === undefined ? {} : { targetAgentId: target }),
              },
        ),
    );

    if (firstRun) {
      const detections = yield* firstRunDetections(context.appConfig);
      store.refreshActiveMenu(
        buildHome({
          ...base,
          agents: [],
          lastUsedWords: new Map(),
          waiting: [],
          ollamaModels: detections.ollamaModels,
          detected: detections.detected,
        }),
      );
    } else {
      const activity = yield* conversationActivity(context.agents);
      const waiting = yield* waitingWork(context.agents, activity.titles, nowMs);
      const lastUsedWords = new Map(
        [...activity.lastUsedMs].map(([id, at]) => [id, formatRelativeWhen(at, nowMs)]),
      );
      store.refreshActiveMenu(
        buildHome({
          ...base,
          agents: agentUsage(context.agents, activity.lastUsedMs),
          lastUsedWords,
          waiting,
        }),
      );
    }

    return yield* Effect.promise(() => answered);
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
    conversationId?: string;
    initialMessage?: string;
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
 * Every saved conversation across agents, titled by what it is about, with the ones waiting on
 * you first and what each needs. A waiting goal can be ended here while keeping its history.
 */
function resumeConversation(agents: readonly Agent[], terminal: TerminalService) {
  return Effect.gen(function* () {
    type ConversationEntry = {
      agent: Agent;
      conversationId: string;
      title: string;
      startedAt: string;
      lastMessageAt: string | null;
    };
    const entries: ConversationEntry[] = [];
    const titles = new Map<string, string>();

    for (const agent of agents) {
      const history = yield* loadHistory(agent.id).pipe(
        Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
      );
      for (const conversation of history.conversations) {
        titles.set(conversation.conversationId, conversation.title);
        entries.push({
          agent,
          conversationId: conversation.conversationId,
          title: conversation.title,
          startedAt: conversation.startedAt,
          lastMessageAt: conversation.lastMessageAt,
        });
      }
    }

    if (entries.length === 0) {
      yield* terminal.info("There are no saved conversations yet. Start one with enter on home.");
      return;
    }

    const nowMs = Date.now();
    const waiting = new Map(
      (yield* waitingWork(agents, titles, nowMs)).map((source) => [source.conversationId, source]),
    );

    // Waiting conversations first, so the ones home counted are the ones on top; the rest
    // by when they were last in, so the freshest conversation is the first one offered.
    const lastAt = (entry: ConversationEntry): number =>
      new Date(entry.lastMessageAt ?? entry.startedAt).getTime();
    entries.sort(
      (a, b) =>
        Number(waiting.has(b.conversationId)) - Number(waiting.has(a.conversationId)) ||
        lastAt(b) - lastAt(a),
    );
    entries.splice(MAX_RESUME_CHOICES);

    const choices = entries.flatMap((entry, index) => {
      const work = waiting.get(entry.conversationId);
      const age = formatRelativeWhen(lastAt(entry), nowMs);
      const title =
        work === undefined
          ? readableTitle({ conversationTitle: entry.title, agentName: entry.agent.name })
          : readableTitle(work);
      const resume = {
        name: title,
        description:
          work?.detail === undefined
            ? entry.agent.name
            : `${entry.agent.name} · ${briefDetail(work.detail)}`,
        value: `resume:${String(index)}`,
        ...(work === undefined
          ? { tag: age, tagTone: "muted" as const }
          : { tag: waitingTag(work.reason, work.age), tagTone: "accent" as const }),
      };
      return work?.goalId === undefined
        ? [resume]
        : [
            resume,
            {
              name: `End · ${title}`,
              description: `${entry.agent.name} · stop goal and keep conversation history`,
              value: `end:${String(index)}`,
              tag: "end goal",
              tagTone: "warning" as const,
            },
          ];
    });

    const selection = yield* terminal.search<string>(
      waiting.size === 0
        ? "Which conversation?"
        : `Which conversation? ${String(waiting.size)} ${waiting.size === 1 ? "is" : "are"} waiting for you.`,
      {
        choices,
        placeholder: "Type to filter by title",
      },
    );
    if (selection === null || selection === undefined) {
      return;
    }

    const [action, rawIndex] = selection.split(":");
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) {
      return;
    }
    const selected = entries[index];
    if (!selected) {
      return;
    }

    if (action === "end") {
      const work = waiting.get(selected.conversationId);
      if (work?.goalId === undefined) {
        return;
      }
      const outcome = yield* controlGoal(work.goalId, "cancel").pipe(
        Effect.provide(makeFileGoalStoreLayer()),
        Effect.provide(makeFileRunStoreLayer()),
      );
      if (outcome.kind === "refused") {
        yield* terminal.warn(`Could not end ${readableTitle(work)}: ${outcome.reason}`);
        return;
      }
      yield* terminal.info(`Ended ${readableTitle(work)}. Conversation history kept.`);
      return;
    }
    if (action !== "resume") {
      return;
    }

    yield* openConversation(selected.agent, selected.conversationId);
  });
}

/**
 * Continue one saved conversation. Its messages are read here, on demand: pickers need titles
 * and dates, not transcripts, so the chosen conversation is the only one ever loaded. A log that
 * cannot be read is reported rather than opened empty, because the chat would then save over it.
 * Returns whether the chat was opened.
 */
function openConversation(agent: Agent, conversationId: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const loaded = yield* Effect.either(loadConversation(agent.id, conversationId));
    if (loaded._tag === "Left") {
      yield* terminal.error(`Could not open this conversation: ${loaded.left.message}`);
      return false;
    }
    const conversation = loaded.right;
    if (conversation === null) {
      yield* terminal.warn("That conversation is no longer saved.");
      return false;
    }
    yield* startChatWithAgent(agent, {
      conversationId,
      initialHistory: conversation.messages,
      ...(conversation.uiTranscript !== undefined
        ? { initialUiTranscript: conversation.uiTranscript }
        : {}),
    });
    return true;
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
      yield* terminal.log("  Set up a key via 'Settings' or export OPENAI_API_KEY");
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
