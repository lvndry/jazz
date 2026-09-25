import os from "node:os";
import { loadConversation, loadHistory } from "@jazz/adapters/history/conversation-history-service";
import { sortAgents } from "@jazz/core/agent/agent-sort";
import { isLocalServerProvider, isZeroCostLocalModel } from "@jazz/core/constants/local-providers";
import { isOllamaCloudModel } from "@jazz/core/constants/ollama";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { ChatServiceTag } from "@jazz/core/interfaces/chat-service";
import { JazzStateServiceTag } from "@jazz/core/interfaces/jazz-state";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types/index";
import type { ChatMessage } from "@jazz/core/types/message";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { agentModelString } from "@jazz/core/utils/provider-model";
import { Effect } from "effect";
import { formatReasoningSelection } from "@/cli/helpers/reasoning";
import { agentDetailFields } from "./agent-details";
import { deleteAgentCommand } from "./agent-management";
import { configWizardCommand } from "./config-wizard";
import { createAgentCommand } from "./create-agent";
import { editAgentCommand } from "./edit-agent";
import { homeEnvironmentFacts, homeRequirements } from "../ui/fullscreen/home-readiness";
import { store, type ActiveAgentChoice } from "../ui/store";
import { TIPS, type WizardMenuOption } from "../ui/WizardHome";

/**
 * Wizard menu option identifiers
 */
type MenuAction =
  | "resume-conversation"
  | "new-conversation"
  | "create-agent"
  | "edit-agent"
  | "list-agents"
  | "config"
  | "delete-agent"
  | "exit";

/**
 * Interactive wizard command - the main entry point when `jazz` is run with no arguments
 */
export function wizardCommand() {
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
      // Get all agents for the menu
      const agents = yield* agentService.listAgents();

      // Get last used agent ID from runtime state (used to pre-select agents in pickers)
      const jazzState = yield* JazzStateServiceTag;
      const lastUsedAgentId = yield* jazzState.get("wizard.lastUsedAgentId").pipe(
        Effect.map((value) => (typeof value === "string" ? value : null)),
        Effect.catchAll(() => Effect.succeed(null)),
      );

      // Check if any agent has saved conversation history
      let hasConversationHistory = false;
      for (const agent of agents) {
        const history = yield* loadHistory(agent.id).pipe(
          Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
        );
        if (history.conversations.length > 0) {
          hasConversationHistory = true;
          break;
        }
      }

      // Build menu options dynamically
      const menuOptions: WizardMenuOption[] = [];

      if (agents.length > 0) {
        menuOptions.push({
          label: "New conversation",
          value: "new-conversation",
        });
      }

      if (hasConversationHistory) {
        menuOptions.push({
          label: "Resume conversation",
          value: "resume-conversation",
        });
      }

      menuOptions.push({ label: "Create agent", value: "create-agent" });

      if (agents.length > 0) {
        menuOptions.push(
          { label: "List agents", value: "list-agents" },
          { label: "Edit agent", value: "edit-agent" },
          { label: "Delete agent", value: "delete-agent" },
          { label: "Update configuration", value: "config" },
        );
      } else {
        // Even if no agents, allow configuration
        menuOptions.push({ label: "Update configuration", value: "config" });
      }

      menuOptions.push({ label: "Exit", value: "exit" });

      const requirements = homeRequirements({
        agentCount: agents.length,
      });
      const environment = homeEnvironmentFacts();

      const selection = yield* showWizardMenu(menuOptions, requirements, environment);

      // Handle the selected action
      switch (selection) {
        case "resume-conversation": {
          yield* resumeConversation(agents, terminal);
          yield* terminal.clear();
          break;
        }

        case "new-conversation": {
          const selectedAgent =
            agents.length === 1
              ? agents[0]
              : yield* selectAgent(agents, lastUsedAgentId, "pick an agent", "start");
          if (selectedAgent) {
            yield* startChatWithAgent(selectedAgent);
            yield* terminal.clear();
          }
          break;
        }

        case "create-agent": {
          // Track agent count before creation to detect if agent was actually created
          const agentCountBefore = agents.length;

          // Run create agent flow and start chat with newly created agent
          const creationResult = yield* createAgentCommand().pipe(Effect.either);

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
        default:
          shouldExit = true;
          break;
      }
    }

    yield* terminal.log("");
    yield* Effect.sync(() => process.exit(0));
  }).pipe(Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))));
}

/**
 * Show the wizard menu and return the selected action
 */
function showWizardMenu(
  options: WizardMenuOption[],
  requirements: ReturnType<typeof homeRequirements>,
  environment: ReturnType<typeof homeEnvironmentFacts>,
): Effect.Effect<MenuAction, never, never> {
  return Effect.async<MenuAction>((resume) => {
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0] ?? "";
    store.setActiveMenu(
      {
        kind: "menu",
        options,
        requirements,
        environment,
        tip,
      },
      (result) => {
        resume(Effect.succeed(result.kind === "exit" ? "exit" : (result.value as MenuAction)));
      },
    );
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

    // Save as last used agent
    yield* jazzState
      .set("wizard.lastUsedAgentId", agent.id)
      .pipe(Effect.catchAll(() => Effect.void));

    yield* terminal.clear();
    yield* terminal.heading(`Starting chat with: ${agent.name}`);
    yield* terminal.log(`Working directory: ${process.cwd().replace(os.homedir(), "~")}`);
    yield* terminal.log(
      `${agentModelString(agent.config)} - Reasoning: ${formatReasoningSelection(agent.config.reasoning)}`,
    );
    if (agent.description) {
      yield* terminal.log(`Description: ${agent.description}`);
    }
    yield* terminal.log("");
    yield* terminal.info("Type '/help' to see available special commands.");
    yield* terminal.info("Type '/exit' to end the conversation.");
    yield* terminal.log("");

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
function resumeConversation(agents: readonly Agent[], terminal: TerminalService) {
  return Effect.gen(function* () {
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

    entries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    entries.splice(MAX_RESUME_CHOICES);

    const choices = entries.map((entry, idx) => ({
      name: `${entry.title} · ${agentModelString(entry.agent.config)}`,
      value: String(idx),
    }));

    const selectedIdx = yield* terminal.search<string>("Select a conversation to resume:", {
      choices,
      placeholder: "Type to filter conversations…",
    });
    if (selectedIdx === null || selectedIdx === undefined) return;

    const selected = entries[Number(selectedIdx)];
    if (!selected) return;

    // Read on demand: the picker above needs titles and dates, not transcripts, so the
    // chosen conversation is the only one whose messages are ever loaded.
    const conversation = yield* loadConversation(selected.agent.id, selected.conversationId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );

    yield* startChatWithAgent(selected.agent, {
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

    // Check for API keys from environment variables
    const envVarMap: Record<string, string> = {
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      GOOGLE_GENERATIVE_AI_API_KEY: "google",
      MISTRAL_API_KEY: "mistral",
      XAI_API_KEY: "xai",
      DEEPSEEK_API_KEY: "deepseek",
      GROQ_API_KEY: "groq",
      OPENROUTER_API_KEY: "openrouter",
      OLLAMA_API_KEY: "ollama",
    };
    const detectedProviders: string[] = [];
    for (const [envVar, provider] of Object.entries(envVarMap)) {
      if (process.env[envVar]) {
        detectedProviders.push(`${provider} (${envVar})`);
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
