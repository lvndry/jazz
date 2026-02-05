import { Effect } from "effect";
import React from "react";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { AgentServiceTag } from "@/core/interfaces/agent-service";
import { ChatServiceTag } from "@/core/interfaces/chat-service";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import type { Agent } from "@/core/types/index";
import { listAgentsCommand, deleteAgentCommand } from "./agent-management";
import { configWizardCommand } from "./config-wizard";
import { createAgentCommand } from "./create-agent";
import { editAgentCommand } from "./edit-agent";
import { store } from "../ui/App";
import { WizardHome, type WizardMenuOption } from "../ui/WizardHome";

/**
 * Wizard menu option identifiers
 */
type MenuAction =
  | "continue"
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

      // Get last used agent ID from config
      const lastUsedAgentId = yield* configService.get("wizard.lastUsedAgentId").pipe(
        Effect.map((value) => (typeof value === "string" ? value : null)),
        Effect.catchAll(() => Effect.succeed(null))
      );

      // Check if last used agent still exists
      let lastUsedAgent: Agent | null = null;
      if (lastUsedAgentId) {
        const agentResult = yield* Effect.either(
          agentService.getAgent(lastUsedAgentId)
        );
        if (agentResult._tag === "Right") {
          lastUsedAgent = agentResult.right;
        }
      }

      // Build menu options dynamically
      const menuOptions: WizardMenuOption[] = [];

      if (lastUsedAgent) {
        menuOptions.push({
          label: `Resume: ${lastUsedAgent.name}`,
          value: "continue",
        });
      }

      if (agents.length > 0) {
        menuOptions.push({
          label: "New conversation",
          value: "new-conversation",
        });
      }

      menuOptions.push(
        { label: "Create agent", value: "create-agent" },
      );

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

      // Show wizard menu and wait for selection
      const selection = yield* showWizardMenu(menuOptions);

      // Handle the selected action
      switch (selection) {
        case "continue": {
          if (lastUsedAgent) {
            yield* startChatWithAgent(lastUsedAgent, configService);
            yield* terminal.clear();
          }
          break;
        }

        case "new-conversation": {
          const selectedAgent = yield* selectAgent(agents, terminal, "Select an agent to chat with:");
          if (selectedAgent) {
            yield* startChatWithAgent(selectedAgent, configService);
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
            yield* terminal.clear();
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
          yield* startChatWithAgent(newest, configService).pipe(
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
          const selectedAgent = yield* selectAgent(agents, terminal, "Select an agent to edit:");
          if (selectedAgent) {
            yield* editAgentCommand(selectedAgent.id).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  yield* terminal.error(`Failed to edit agent: ${String(error)}`);
                })
              )
            );
            yield* terminal.clear();
          }
          break;
        }

        case "list-agents": {
          yield* listAgentsCommand().pipe(
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                yield* terminal.error(`Failed to list agents: ${String(error)}`);
              })
            )
          );
          // Pause to let user see the list
          yield* terminal.ask("Press Enter to continue...", { hidden: true });
          yield* terminal.clear();
          break;
        }

        case "delete-agent": {
          const selectedAgent = yield* selectAgent(agents, terminal, "Select an agent to delete:");
          if (selectedAgent) {
            yield* deleteAgentCommand(selectedAgent.id).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  yield* terminal.error(`Failed to delete agent: ${String(error)}`);
                })
              )
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
  }).pipe(
    Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e))))
  );
}

/**
 * Show the wizard menu and return the selected action
 */
function showWizardMenu(
  options: WizardMenuOption[]
): Effect.Effect<MenuAction, never, never> {
  return Effect.async<MenuAction>((resume) => {
    store.setCustomView(
      React.createElement(WizardHome, {
        options,
        onSelect: (value: string) => {
          store.setCustomView(null);
          resume(Effect.succeed(value as MenuAction));
        },
        onExit: () => {
          store.setCustomView(null);
          resume(Effect.succeed("exit" as MenuAction));
        },
      })
    );
  });
}

/**
 * Show agent selection menu
 */
function selectAgent(
  agents: readonly Agent[],
  terminal: TerminalService,
  message: string
): Effect.Effect<Agent | null, never, never> {
  return Effect.gen(function* () {
    if (agents.length === 0) {
      yield* terminal.warn("No agents available.");
      return null;
    }

    const choices = agents.map((agent) => ({
      name: `${agent.name} - ${agent.description || agent.config.agentType || "default"}`,
      value: agent.id,
    }));

    const selectedId = yield* terminal.select<string>(message, { choices });

    if (!selectedId) {
      return null;
    }

    return agents.find((a) => a.id === selectedId) ?? null;
  });
}

/**
 * Start a chat session with an agent and save as last used
 */
function startChatWithAgent(
  agent: Agent,
  configService: AgentConfigService
) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    // Save as last used agent
    yield* configService.set("wizard.lastUsedAgentId", agent.id).pipe(
      Effect.catchAll(() => Effect.void)
    );

    yield* terminal.clear();
    yield* terminal.heading(`Starting chat with: ${agent.name}`);
    yield* terminal.log(`${agent.model} - Reasoning: ${agent.config.reasoningEffort ?? "disabled"}`);
    if (agent.description) {
      yield* terminal.log(`   Description: ${agent.description}`);
    }
    yield* terminal.log("");
    yield* terminal.info("Type '/exit' to end the conversation.");
    yield* terminal.info("Type '/help' to see available special commands.");
    yield* terminal.log("");

    // Start the chat session
    const chatService = yield* ChatServiceTag;
    yield* chatService.startChatSession(agent).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* terminal.error(`Chat session error: ${String(error)}`);
        })
      )
    );
  });
}

/**
 * Check if this is the first run and prompt for notification preferences
 */
function promptNotificationsOnFirstRun(
  configService: AgentConfigService,
  terminal: TerminalService
) {
  return Effect.gen(function* () {
    // Check if notifications have ever been configured
    const hasNotificationsConfigured = yield* configService.has("notifications.enabled");

    if (hasNotificationsConfigured) {
      return; // Already configured, skip prompt
    }

    // First run - ask user about notifications
    yield* terminal.log("");
    yield* terminal.heading("🎷 Welcome to Jazz!");
    yield* terminal.log("");
    yield* terminal.info("Jazz can send you desktop notifications when:");
    yield* terminal.log("  • A task is completed");
    yield* terminal.log("  • Approval is needed for an action");
    yield* terminal.log("");

    const enableNotifications = yield* terminal.confirm(
      "Would you like to enable desktop notifications?",
      true // Default to yes
    );

    yield* configService.set("notifications.enabled", enableNotifications);

    if (enableNotifications) {
      const enableSound = yield* terminal.confirm(
        "Play a sound with notifications?",
        true
      );
      yield* configService.set("notifications.sound", enableSound);
      yield* terminal.success("Notifications enabled! You can change this anytime in Settings.");
    } else {
      yield* terminal.info("Notifications disabled. You can enable them anytime in Settings.");
    }

    yield* terminal.log("");
  });
}
