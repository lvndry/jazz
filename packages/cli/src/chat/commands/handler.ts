import { spawn } from "node:child_process";
import { FileSystem } from "@effect/platform";
import { loadConversation, loadHistory } from "@jazz/adapters/history/conversation-history-service";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { sortAgents } from "@jazz/core/agent/agent-sort";
import { resolveContextThresholds } from "@jazz/core/agent/context/context-thresholds";
import { resolveEffectiveContextWindow } from "@jazz/core/agent/context/effective-context-window";
import { DEFAULT_TOKEN_COUNTER } from "@jazz/core/agent/context/token-counter";
import {
  clearWorkState,
  readJournal,
  workStateSizeBytes,
} from "@jazz/core/agent/context/work-journal";
import { formatWorkState, readWorkState } from "@jazz/core/agent/context/work-state";
import { matchForbiddenCommand, runShellCommand } from "@jazz/core/agent/tools/shell-tools";
import { BUILTIN_TOOL_CATEGORIES } from "@jazz/core/agent/tools/tool-categories";
import { WEB_SEARCH_PROVIDERS } from "@jazz/core/agent/tools/web-search-tools";
import { normalizeToolConfig } from "@jazz/core/agent/utils/tool-config";
import type { ProviderName } from "@jazz/core/constants/models";
import { AVAILABLE_PROVIDERS } from "@jazz/core/constants/models";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "@jazz/core/interfaces/fs";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import {
  MCPServerManagerTag,
  isHttpConfig,
  isStdioConfig,
  type MCPServerManager,
} from "@jazz/core/interfaces/mcp-server";
import { PersonaServiceTag, type PersonaService } from "@jazz/core/interfaces/persona-service";
import type { PresentationService } from "@jazz/core/interfaces/presentation";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@jazz/core/interfaces/tool-registry";
import { SkillServiceTag, type SkillService } from "@jazz/core/skills/skill-service";
import { StorageError, StorageNotFoundError } from "@jazz/core/types/errors";
import type { MCPPromptArgument, MCPPromptMessage } from "@jazz/core/types/mcp";
import type { ChatMessage } from "@jazz/core/types/message";
import type { AutoApprovePolicy } from "@jazz/core/types/tools";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { describeCronSchedule } from "@jazz/core/utils/cron";
import { createSanitizedEnv } from "@jazz/core/utils/env";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import type { WorkflowMetadata } from "@jazz/core/workflows/workflow-service";
import { WorkflowServiceTag, type WorkflowService } from "@jazz/core/workflows/workflow-service";
import { groupWorkflows } from "@jazz/core/workflows/workflow-utils";
import { Effect, Option } from "effect";
import { describeTier } from "@/cli/commands/peers";
import { getGlyphs } from "@/cli/ui/glyphs";
import { getThemeVariant, setThemeVariant } from "@/cli/ui/theme";
import * as fmt from "@/cli/utils/list-format";
import { CHAT_COMMANDS } from "./constants";
import type { CommandContext, CommandResult, SpecialCommand } from "./types";

/**
 * Handle special commands from user input.
 *
 * This function dispatches to individual command handlers based on the command type.
 */
export function handleSpecialCommand(
  command: SpecialCommand,
  context: CommandContext,
): Effect.Effect<
  CommandResult,
  StorageError | StorageNotFoundError | Error,
  | ToolRegistry
  | TerminalService
  | AgentService
  | FileSystemContextService
  | LoggerService
  | LLMService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
  | SkillService
  | WorkflowService
  | MCPServerManager
  | FileSystem.FileSystem
  | PersonaService
> {
  const { agent, conversationId, conversationHistory } = context;

  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    switch (command.type) {
      case "new":
        return yield* handleNewCommand(terminal, agent);

      case "fork":
        return yield* handleForkCommand(terminal, conversationHistory);

      case "help":
        return yield* handleHelpCommand(terminal, command.args);

      case "tools":
        return yield* handleToolsCommand(terminal, agent);

      case "agents":
        return yield* handleAgentsCommand(terminal, agent, context.lastUsedAgentId ?? null);

      case "peers":
        return yield* handlePeersCommand(terminal);

      case "switch":
        return yield* handleSwitchCommand(
          terminal,
          agent,
          command.args,
          context.lastUsedAgentId ?? null,
        );

      case "compact":
        return yield* handleCompactCommand(terminal, agent, conversationHistory, conversationId);

      case "copy":
        return yield* handleCopyCommand(terminal, conversationHistory);

      case "model":
        return yield* handleModelCommand(terminal, agent, command.args);

      case "reasoning":
        return yield* handleReasoningCommand(terminal, agent, command.args);

      case "config":
        return yield* handleConfigCommand(terminal, agent, command.args);

      case "skills":
        return yield* handleSkillsCommand(terminal);

      case "context":
        return yield* handleContextCommand(terminal, agent, conversationHistory);

      case "work":
        return yield* handleWorkCommand(terminal, agent, context.conversationId, command.args);

      case "cost":
        return yield* handleCostCommand(terminal, agent, context.sessionUsage);

      case "workflows":
        return yield* handleWorkflowsCommand(terminal);

      case "stats":
        return yield* handleStatsCommand(terminal, agent, context);

      case "mcp":
        return yield* handleMcpCommand(terminal, command.args);

      case "mode":
        return yield* handleModeCommand(
          terminal,
          command.args,
          context.autoApprovePolicy,
          context.autoApprovedCommands,
          context.persistedAutoApprovedCommands,
          context.autoApprovedTools,
        );

      case "resume":
        return yield* handleResumeCommand(terminal, agent);

      case "theme":
        return yield* handleThemeCommand(terminal, command.args);

      case "export":
        return yield* handleExportCommand(terminal, agent, conversationHistory, command.args);

      case "retry":
        return yield* handleRetryCommand(terminal, conversationHistory);

      case "shell":
        return yield* handleShellCommand(command.args[0] ?? "", context);

      case "clear":
        return yield* handleClearCommand(terminal, agent);

      case "runSkill":
        return yield* handleRunSkillCommand(command.args);

      case "runMcpPrompt":
        return yield* handleRunMcpPromptCommand(terminal, command.args);

      case "unknown":
        return yield* handleUnknownCommand(terminal, command.args);

      default:
        return { shouldContinue: true };
    }
  });
}

/**
 * Execute a command explicitly entered by the operator with a leading `!`.
 *
 * This is intentionally outside the model tool loop: the operator authored the
 * command and its output is then handed to the model as context. It still uses
 * the shell tool's denylist, sanitized environment, cwd resolution, timeout,
 * and output cap so the two shell entry points share the same host boundary —
 * except it runs `interactive: true`, loading the operator's own shell rc file
 * (aliases, functions), since the operator typed this command themselves and
 * expects it to behave like their own terminal. The model-invoked
 * `execute_command` tool must never set this.
 */
function handleShellCommand(
  command: string,
  context: CommandContext,
): Effect.Effect<CommandResult, never, FileSystemContextService | LoggerService | TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const shell = yield* FileSystemContextServiceTag;
    const logger = yield* LoggerServiceTag;
    const trimmedCommand = command.trim();

    if (!trimmedCommand) {
      yield* terminal.error("Usage: ! <shell command>");
      return { shouldContinue: true };
    }

    const forbidden = matchForbiddenCommand(trimmedCommand);
    if (forbidden) {
      const error = `Command blocked by the built-in safety denylist: ${forbidden.reason}`;
      yield* terminal.error(error);
      return {
        shouldContinue: true,
        messageForAgent: `The operator tried to run this shell command with \`!\`, but Jazz blocked it: ${error}`,
      };
    }

    const workingDirectory = yield* shell.getCwd({
      agentId: context.agent.id,
      conversationId: context.conversationId,
    });
    const result = yield* runShellCommand({
      command: trimmedCommand,
      workingDir: workingDirectory,
      timeoutMs: 900_000,
      env: createSanitizedEnv({}, context.agent.config.envAllowlist ?? []),
      interactive: true,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          stdout: "",
          stderr: error.message,
          exitCode: -1,
        }),
      ),
    );

    const combinedOutput = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""]
      .filter(Boolean)
      .join("\n")
      .trim();
    yield* logger.info("Interactive shell escape completed", {
      exitCode: result.exitCode,
      workingDirectory,
    });
    yield* terminal.log(
      combinedOutput || `(command exited with code ${result.exitCode}; no output)`,
    );

    return {
      shouldContinue: true,
      messageForAgent: [
        `The operator ran this command with \`!\` in ${workingDirectory}:`,
        "",
        "```sh",
        trimmedCommand,
        "```",
        "",
        `Exit code: ${result.exitCode}`,
        "",
        combinedOutput ? `Command output:\n${combinedOutput}` : "Command output: (none)",
        "",
        "Use this command result as context for your response. Do not claim to have run the command yourself.",
      ].join("\n"),
    };
  });
}

/**
 * Handle /new command - Start a new conversation
 */
function handleNewCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.clear();
    yield* terminal.info("Starting new conversation...");
    yield* terminal.log(fmt.item("Conversation context cleared"));
    yield* terminal.log(fmt.item("Fresh start with the agent"));

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

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.blank());
    return {
      shouldContinue: true,
      newConversationId: generateConversationId(),
      newHistory: [],
      saveCurrentHistory: true,
    };
  });
}

/**
 * Handle /fork command - Fork the conversation into a new branch
 *
 * Creates a new conversation ID, keeping only the system prompt and the
 * last user message from the current history. This gives the user a clean
 * branch to explore a different approach to their most recent question
 * without carrying over the entire conversation context.
 */
function handleForkCommand(
  terminal: TerminalService,
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    if (conversationHistory.length === 0) {
      yield* terminal.warn("Cannot fork: no messages in history.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    // Keep the system message (first message) and the last user message
    const systemMessage = conversationHistory.find((m) => m.role === "system");
    const lastUserMessage = [...conversationHistory].reverse().find((m) => m.role === "user");

    if (!lastUserMessage) {
      yield* terminal.warn("No user message found to fork from.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    const newHistory: ChatMessage[] = [];
    if (systemMessage) {
      newHistory.push(systemMessage);
    }
    newHistory.push(lastUserMessage);

    yield* terminal.info("Forking conversation...");
    yield* terminal.log(fmt.item("New conversation branch created"));
    yield* terminal.log(fmt.item("Kept last user message as starting point"));
    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.blank());
    return {
      shouldContinue: true,
      newConversationId: generateConversationId(),
      newHistory,
      saveCurrentHistory: true,
    };
  });
}

/**
 * Handle /export command - write the conversation to a markdown file.
 */
function handleExportCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  conversationHistory: CommandContext["conversationHistory"],
  args: string[],
): Effect.Effect<CommandResult, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (conversationHistory.length === 0) {
      yield* terminal.warn("Nothing to export yet — the conversation is empty.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    // args is whitespace-split by the parser — rejoin so paths with spaces
    // survive, and expand a leading ~ (the shell doesn't expand it for us).
    const rawPath = args.join(" ").trim();
    const homeDir = process.env["HOME"];
    const targetPath =
      rawPath.length > 0
        ? rawPath.startsWith("~/") && homeDir
          ? `${homeDir}${rawPath.slice(1)}`
          : rawPath
        : `jazz-conversation-${timestamp}.md`;

    const lines: string[] = [
      `# Conversation with ${agent.name}`,
      "",
      `Exported ${new Date().toISOString()} · ${conversationHistory.length} messages`,
      "",
    ];
    for (const message of conversationHistory) {
      if (!message.content) continue;
      const speaker = message.role === "user" ? "You" : agent.name;
      lines.push(`## ${speaker}`, "", message.content, "");
    }

    const fs = yield* FileSystem.FileSystem;
    const result = yield* fs.writeFileString(targetPath, lines.join("\n")).pipe(Effect.either);

    if (result._tag === "Left") {
      yield* terminal.error(`Failed to export conversation: ${String(result.left)}`);
    } else {
      yield* terminal.success(`Conversation exported to ${targetPath}`);
    }
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /retry command - re-send the last user message. History is
 * truncated to just before that message so the rerun doesn't duplicate it.
 */
function handleRetryCommand(
  terminal: TerminalService,
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    for (let index = conversationHistory.length - 1; index >= 0; index--) {
      const message = conversationHistory[index];
      if (message && message.role === "user" && message.content) {
        return {
          shouldContinue: true,
          newHistory: conversationHistory.slice(0, index),
          resendMessage: message.content,
        };
      }
    }
    yield* terminal.warn("No previous message to retry.");
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /theme command - show or switch the light/dark theme.
 */
function handleThemeCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    const requested = args[0]?.toLowerCase();
    if (requested === "light" || requested === "dark") {
      setThemeVariant(requested);
      process.env["JAZZ_THEME"] = requested;
      yield* terminal.success(`Theme switched to ${requested}.`);
      yield* terminal.info(
        `Persist it across sessions with: export JAZZ_THEME=${requested} (a restart applies it to every surface).`,
      );
      return { shouldContinue: true };
    }
    if (requested !== undefined) {
      yield* terminal.warn(`Unknown theme "${requested}".`);
    }
    yield* terminal.log(fmt.heading("Theme"));
    yield* terminal.log(fmt.keyValueCompact("Current", getThemeVariant()));
    yield* terminal.log(fmt.footer("Usage: /theme light | /theme dark"));
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/** Keyboard shortcuts surfaced in /help. Keep in sync with App.tsx bindings. */
const KEYBOARD_SHORTCUTS: ReadonlyArray<readonly [keys: string, description: string]> = [
  ["Esc Esc", "Interrupt the current generation"],
  ["Shift+Tab", "Toggle safe/yolo approval mode"],
  ["Ctrl+R", "Expand collapsed reasoning (repeat for earlier blocks)"],
  ["Ctrl+O", "Expand the last truncated diff or tool output"],
  ["Tab", "Complete the highlighted slash command"],
  ["Up/Down", "Recall previously sent messages (empty input)"],
  ["Shift+Enter", "Insert a newline for a multi-line message"],
  ["Esc", "Clear the current draft"],
  ["Up (agent busy)", "Recall queued messages for editing"],
  ["Ctrl+X (agent busy)", "Clear the message queue"],
];

/**
 * Handle /help command. Rendered from CHAT_COMMANDS (the same list that
 * powers autocomplete) so the two can never drift. `/help <command>` shows
 * that command's usage detail.
 */
function handleHelpCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    const requested = args[0]?.toLowerCase().replace(/^\//, "");
    if (requested !== undefined) {
      const command = CHAT_COMMANDS.find((candidate) => candidate.name === requested);
      if (!command) {
        yield* terminal.warn(`Unknown command "/${requested}". Run /help for the full list.`);
        return { shouldContinue: true };
      }
      yield* terminal.log(fmt.heading(`/${command.name}`));
      yield* terminal.log(
        fmt.keyValueCompact("Usage", `/${command.name}${command.usage ? ` ${command.usage}` : ""}`),
      );
      yield* terminal.log(fmt.keyValueCompact("Description", command.description));
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    yield* terminal.log(fmt.heading("Available Commands"));
    yield* terminal.log(
      CHAT_COMMANDS.map((command) =>
        fmt.commandRow(
          `/${command.name}${command.usage ? ` ${command.usage}` : ""}`,
          command.description,
          34,
        ),
      ).join("\n"),
    );
    yield* terminal.log(
      fmt.commandRow("! <command>", "Run a shell command and give its output to the agent", 34),
    );
    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.heading("Keyboard Shortcuts"));
    yield* terminal.log(
      KEYBOARD_SHORTCUTS.map(([keys, description]) => fmt.commandRow(keys, description, 34)).join(
        "\n",
      ),
    );
    yield* terminal.log(fmt.footer("Run /help <command> for details on a specific command."));
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /tools command - List agent tools by category
 */
function handleToolsCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<
  CommandResult,
  never,
  ToolRegistry | AgentConfigService | LLMService | PersonaService
> {
  return Effect.gen(function* () {
    const toolRegistry = yield* ToolRegistryTag;
    const allToolsByCategory = yield* toolRegistry.listToolsByCategory();

    const agentToolNames = normalizeToolConfig(agent.config.tools, {
      agentId: agent.id,
    });

    // Mirrors initializeAgentRun's category resolution (agent-runner.ts) so this
    // display reflects the tools the agent actually gets at runtime, not just
    // what's explicitly stored in its config.
    const personaServiceOption = yield* Effect.serviceOption(PersonaServiceTag);
    const resolvedPersona = Option.isSome(personaServiceOption)
      ? yield* personaServiceOption.value
          .getPersonaByIdentifier(agent.config.persona)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
      : null;
    const toolProfile = resolvedPersona?.toolProfile;

    const requestedBuiltinCategoryIds: readonly string[] =
      toolProfile?.categories !== undefined
        ? toolProfile.categories
        : agent.config.persona === "summarizer"
          ? []
          : BUILTIN_TOOL_CATEGORIES.map((c) => c.id);

    const validBuiltinCategoryIds = new Set(BUILTIN_TOOL_CATEGORIES.map((c) => c.id));
    const builtInToolNames = (yield* Effect.all(
      requestedBuiltinCategoryIds
        .filter((id) => validBuiltinCategoryIds.has(id))
        .map((id) => toolRegistry.getToolsInCategory(id)),
    )).flat();

    let combinedToolNames = [...new Set([...agentToolNames, ...builtInToolNames])];
    if (toolProfile?.deny && toolProfile.deny.length > 0) {
      const denied = new Set(toolProfile.deny);
      combinedToolNames = combinedToolNames.filter((name) => !denied.has(name));
    }
    const agentToolSet = new Set(combinedToolNames);

    const filteredToolsByCategory: Record<string, readonly string[]> = {};
    for (const [category, tools] of Object.entries(allToolsByCategory)) {
      const filteredTools = tools.filter((tool) => agentToolSet.has(tool));
      if (filteredTools.length > 0) {
        filteredToolsByCategory[category] = filteredTools;
      }
    }

    // Resolve web_search provider info for annotation
    const webSearchProvider = yield* resolveWebSearchProviderLabel(agent);

    yield* terminal.log(fmt.heading(`Tools Available to ${agent.name}`));

    if (Object.keys(filteredToolsByCategory).length === 0) {
      yield* terminal.warn("This agent has no tools configured.");
    } else {
      const sortedCategories = Object.keys(filteredToolsByCategory).sort();

      for (const category of sortedCategories) {
        const tools = filteredToolsByCategory[category];
        if (tools && tools.length > 0) {
          yield* terminal.log(fmt.section(category, tools.length, "tool"));
          for (const tool of tools) {
            if (tool === "web_search" && webSearchProvider) {
              yield* terminal.log(fmt.itemWithDesc(tool, webSearchProvider));
            } else {
              yield* terminal.log(fmt.item(tool));
            }
          }
          yield* terminal.log(fmt.blank());
        }
      }

      const totalTools = Object.values(filteredToolsByCategory).reduce(
        (sum, tools) => sum + (tools?.length || 0),
        0,
      );

      yield* terminal.log(
        fmt.footer(`Total: ${totalTools} tools across ${sortedCategories.length} categories`),
      );
    }

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Resolve a human-readable label for the active web_search provider.
 *
 * Returns e.g. "via Brave", "via OpenAI (native)", or null if web_search
 * is not in use / no provider could be determined.
 */
function resolveWebSearchProviderLabel(
  agent: CommandContext["agent"],
): Effect.Effect<string | null, never, AgentConfigService | LLMService> {
  return Effect.gen(function* () {
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;

    // 1. Check for an explicitly configured external provider
    const externalProvider = appConfig.web_search?.provider;
    if (externalProvider) {
      const display =
        WEB_SEARCH_PROVIDERS.find((p) => p.value === externalProvider)?.name ?? externalProvider;
      return `via ${display}`;
    }

    // 2. Check if the agent's LLM provider supports native web search
    const llmService = yield* LLMServiceTag;
    const supportsNative = yield* llmService.supportsNativeWebSearch(agent.config.llmProvider);
    if (supportsNative) {
      const providerName =
        agent.config.llmProvider.charAt(0).toUpperCase() + agent.config.llmProvider.slice(1);
      return `via ${providerName} (native)`;
    }

    // 3. No provider available
    return "no provider configured";
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

/**
 * Handle /agents command - Open an overlay to switch agents mid-session.
 *
 * In an interactive terminal this reuses the `/switch` picker (a searchable
 * overlay you move through with up/down and accept with enter), so choosing an
 * agent switches to it without typing its id. In a non-interactive terminal
 * there is no overlay to render, so the command falls back to the classic
 * listing of every agent.
 */
function handleAgentsCommand(
  terminal: TerminalService,
  currentAgent: CommandContext["agent"],
  lastUsedAgentId: string | null,
): Effect.Effect<CommandResult, StorageError | StorageNotFoundError | Error, AgentService> {
  return Effect.gen(function* () {
    if (terminal.isInteractive) {
      // Delegate to the interactive `/switch` picker, which opens the agent
      // overlay and switches on selection. Empty args means "show the picker".
      return yield* handleSwitchCommand(terminal, currentAgent, [], lastUsedAgentId);
    }

    const agentService = yield* AgentServiceTag;
    const allAgentsUnsorted = yield* agentService.listAgents();

    yield* terminal.log(fmt.heading("Available Agents"));

    if (allAgentsUnsorted.length === 0) {
      yield* terminal.warn("No agents found.");
      yield* terminal.info("Create one with: jazz agent create");
    } else {
      const allAgents = sortAgents(allAgentsUnsorted, lastUsedAgentId);

      for (const ag of allAgents) {
        const isCurrent = ag.id === currentAgent.id;

        if (isCurrent) {
          yield* terminal.log(fmt.labeledItem(ag.name, "(current)"));
        } else {
          yield* terminal.log(fmt.labeledItemDim(ag.name));
        }
        yield* terminal.log(fmt.keyValue("ID", ag.id));
        if (ag.description) {
          const truncatedDesc =
            ag.description.length > 80 ? ag.description.substring(0, 77) + "..." : ag.description;
          yield* terminal.log(fmt.keyValue("Description", truncatedDesc));
        }
        yield* terminal.log(
          fmt.keyValue("Model", `${ag.config.llmProvider}/${ag.config.llmModel}`),
        );
        yield* terminal.log(fmt.keyValue("Persona", ag.config.persona));
        if (ag.config.reasoningEffort) {
          yield* terminal.log(fmt.keyValue("Reasoning", ag.config.reasoningEffort));
        }
        yield* terminal.log(fmt.blank());
      }

      yield* terminal.log(
        fmt.footer(`Total: ${allAgents.length} agent${allAgents.length === 1 ? "" : "s"}`),
      );
    }

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /peers command - list who this agent's daemon can ask or answer
 */
function handlePeersCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, StorageError | StorageNotFoundError | Error, AgentConfigService> {
  return Effect.gen(function* () {
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const peers = appConfig.peers ?? [];

    yield* terminal.log(fmt.heading("Peers"));

    if (peers.length === 0) {
      yield* terminal.warn("No peers configured.");
      yield* terminal.info("Add one with an invite: jazz peers invite create/accept");
    } else {
      for (const peer of peers) {
        yield* terminal.log(fmt.labeledItem(peer.name));
        yield* terminal.log(
          fmt.keyValue("Can ask them", peer.url !== undefined ? peer.url : "no — not granted"),
        );
        yield* terminal.log(fmt.keyValue("They may learn", describeTier(peer.disclosure)));
        if (peer.persona !== undefined) {
          yield* terminal.log(fmt.keyValue("Answers as", peer.persona));
        }
        if (peer.allow !== undefined && peer.allow.length > 0) {
          yield* terminal.log(fmt.keyValue("Extra grants", peer.allow.join(", ")));
        }
        yield* terminal.log(fmt.blank());
      }

      yield* terminal.log(
        fmt.footer(`Total: ${peers.length} peer${peers.length === 1 ? "" : "s"}`),
      );
    }

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /switch command - Switch to a different agent
 */
function handleSwitchCommand(
  terminal: TerminalService,
  currentAgent: CommandContext["agent"],
  args: string[],
  lastUsedAgentId: string | null,
): Effect.Effect<CommandResult, StorageError | StorageNotFoundError | Error, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // Check if agent identifier was provided as argument
    if (args.length > 0) {
      const agentIdentifier = args.join(" ").trim();

      // Try to get agent by identifier (name or ID)
      const switchResult = yield* getAgentByIdentifier(agentIdentifier).pipe(
        Effect.map((foundAgent) => ({ success: true as const, agent: foundAgent })),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            if (error._tag === "StorageNotFoundError") {
              yield* terminal.error(`Agent not found: ${agentIdentifier}`);
              yield* terminal.info("Use '/agents' to see all available agents.");
              yield* terminal.log("");
            } else {
              yield* terminal.error(
                `Error loading agent: ${error instanceof Error ? error.message : String(error)}`,
              );
              yield* terminal.log("");
            }
            return { success: false as const };
          }),
        ),
      );

      if (switchResult.success) {
        const newAgent = switchResult.agent;
        yield* terminal.setTitle(`🎷 Jazz - ${newAgent.name}`);
        yield* terminal.success(
          `Switched to ${newAgent.name} (${newAgent.config.llmProvider}/${newAgent.config.llmModel})`,
        );

        // Check if model supports tools and warn if not
        const modelMeta = yield* Effect.promise(() =>
          getModelsDevMetadata(newAgent.config.llmModel, newAgent.config.llmProvider),
        );
        if (
          modelMeta &&
          !modelMeta.supportsTools &&
          newAgent.config.tools &&
          newAgent.config.tools.length > 0
        ) {
          yield* terminal.log("");
          yield* terminal.warn(
            `⚠️  The current model (${newAgent.config.llmModel}) does not support tools. Your configured tools will not be available.`,
          );
        }

        yield* terminal.log("");
        return { shouldContinue: true, newAgent };
      }

      return { shouldContinue: true };
    }

    // Interactive mode - show list of agents
    const allAgentsUnsorted = yield* agentService.listAgents();

    if (allAgentsUnsorted.length === 0) {
      yield* terminal.warn("No agents available to switch to.");
      yield* terminal.info("Create one with: jazz agent create");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    if (allAgentsUnsorted.length === 1) {
      yield* terminal.warn("Only one agent available. Cannot switch.");
      yield* terminal.info("Create more agents with: jazz agent create");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    // Sort with last-used agent first, then alphabetically
    const allAgents = sortAgents(allAgentsUnsorted, lastUsedAgentId);

    // Show interactive prompt with history preservation note
    yield* terminal.info("History will be preserved after switching.");
    const choices = allAgents.map((ag) => ({
      name: `${ag.name} - ${ag.config.llmProvider}/${ag.config.llmModel} · ${ag.config.persona}${ag.id === currentAgent.id ? " (current)" : ""}`,
      value: ag.id,
    }));

    const selectedAgentId = yield* terminal.search<string>("Select an agent to switch to:", {
      choices,
      placeholder: "Type to filter agents…",
    });

    // User cancelled selection (Escape key)
    if (!selectedAgentId) {
      return { shouldContinue: true };
    }

    // If user selected the same agent, do nothing
    if (selectedAgentId === currentAgent.id) {
      yield* terminal.info("Already using this agent.");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const newAgent = yield* agentService.getAgent(selectedAgentId);

    yield* terminal.success(
      `Switched to ${newAgent.name} (${newAgent.config.llmProvider}/${newAgent.config.llmModel})`,
    );

    // Check if model supports tools and warn if not
    const modelMeta = yield* Effect.promise(() =>
      getModelsDevMetadata(newAgent.config.llmModel, newAgent.config.llmProvider),
    );
    if (
      modelMeta &&
      !modelMeta.supportsTools &&
      newAgent.config.tools &&
      newAgent.config.tools.length > 0
    ) {
      yield* terminal.log("");
      yield* terminal.warn(
        `⚠️  The current model (${newAgent.config.llmModel}) does not support tools. Your configured tools will not be available.`,
      );
    }

    yield* terminal.log("");

    return { shouldContinue: true, newAgent };
  });
}

/**
 * Handle /compact command - Summarize history to save tokens
 */
function handleCompactCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  conversationHistory: CommandContext["conversationHistory"],
  conversationId: string,
): Effect.Effect<
  CommandResult,
  Error,
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
> {
  return Effect.gen(function* () {
    if (!conversationHistory || conversationHistory.length < 5) {
      yield* terminal.warn("Not enough history to compact (minimum 5 messages).");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const messageCount = conversationHistory.length - 1; // Exclude system message

    // Stage 1: Reading
    yield* terminal.info(`📖 Reading ${messageCount} messages from conversation history...`);

    try {
      // Keep system message [0], summarize everything else [1...N]
      const messagesToSummarize = conversationHistory.slice(1);

      // Show success for Stage 1
      yield* terminal.success(`📖 Read ${messageCount} messages from conversation history`);
      yield* terminal.log("");

      // Stage 2: Analyzing
      yield* terminal.info("Analyzing content and extracting key information...");

      // Show success for Stage 2
      yield* terminal.success("Analyzed content and extracted key information");
      yield* terminal.log("");

      // Stage 3: Summarizing
      yield* terminal.info("✨ Generating high-density summary...");

      const summaryMessage = yield* AgentRunner.summarizeHistory(
        messagesToSummarize,
        agent,
        conversationId,
      );

      // Show success for Stage 3
      yield* terminal.success("✨ Generated high-density summary");
      yield* terminal.log("");

      const newHistory = [
        conversationHistory[0] as CommandContext["conversationHistory"][0],
        summaryMessage,
      ];

      yield* terminal.success("Conversation context compacted successfully!");
      yield* terminal.log(`   Reduced from ${messageCount + 1} messages to 2 (system + summary)`);
      yield* terminal.log("   Earlier context compressed while preserving key information");
      yield* terminal.log("");

      return { shouldContinue: true, newHistory };
    } catch (error) {
      yield* terminal.error(
        `Failed to compact history: ${error instanceof Error ? error.message : String(error)}`,
      );
      yield* terminal.log("");
      return { shouldContinue: true };
    }
  });
}

/**
 * Handle /copy command - Copy last response to clipboard
 */
/** Platform-appropriate clipboard commands, tried in order. */
function clipboardCommands(): ReadonlyArray<{ cmd: string; args: string[] }> {
  switch (process.platform) {
    case "darwin":
      return [{ cmd: "pbcopy", args: [] }];
    case "win32":
      return [{ cmd: "clip", args: [] }];
    default:
      return [
        { cmd: "wl-copy", args: [] },
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
      ];
  }
}

function copyToClipboard(text: string): Promise<void> {
  const candidates = clipboardCommands();
  const tryCandidate = (index: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const candidate = candidates[index];
      if (!candidate) {
        reject(
          new Error(
            `No clipboard utility found (tried: ${candidates.map((entry) => entry.cmd).join(", ")})`,
          ),
        );
        return;
      }
      const child = spawn(candidate.cmd, candidate.args);
      let advanced = false;
      const advance = (): void => {
        if (advanced) return;
        advanced = true;
        resolve(tryCandidate(index + 1));
      };
      // A dying child can emit EPIPE on stdin before 'close' — without this
      // handler that's an uncaught exception that crashes the CLI.
      child.stdin.on("error", advance);
      child.on("error", advance);
      child.on("close", (code) => {
        if (advanced) return;
        if (code === 0) {
          advanced = true;
          resolve();
        } else {
          // Installed but non-functional (e.g. wl-copy without a Wayland
          // session) — fall through to the next candidate.
          advance();
        }
      });
      child.stdin.write(text);
      child.stdin.end();
    });
  return tryCandidate(0);
}

function handleCopyCommand(
  terminal: TerminalService,
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    // Find the last assistant message in the history
    let lastResponse: string | null = null;
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      if (msg && msg.role === "assistant" && msg.content) {
        lastResponse = msg.content;
        break;
      }
    }

    if (!lastResponse) {
      yield* terminal.warn("No agent response found to copy.");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    yield* Effect.tryPromise({
      try: () => copyToClipboard(lastResponse),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.flatMap(() =>
        Effect.all([
          terminal.success("Last agent response copied to clipboard!"),
          terminal.log(""),
        ]),
      ),
      Effect.catchAll((error) =>
        Effect.all([
          terminal.error(`Failed to copy to clipboard: ${error.message}`),
          terminal.log(""),
        ]),
      ),
    );
    return { shouldContinue: true };
  });
}

/**
 * Handle /model command - Show or change model and reasoning effort
 */
function handleModelCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  args: string[],
): Effect.Effect<CommandResult, StorageError | StorageNotFoundError | Error, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // No args: show current model info
    if (args.length === 0) {
      yield* terminal.log(fmt.heading("Current Model"));
      yield* terminal.log(fmt.keyValueCompact("Provider", agent.config.llmProvider));
      yield* terminal.log(fmt.keyValueCompact("Model", agent.config.llmModel));
      yield* terminal.log(fmt.keyValueCompact("Persona", agent.config.persona));
      yield* terminal.log(
        fmt.keyValueCompact("Reasoning", agent.config.reasoningEffort ?? "default"),
      );
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    // Handle "reasoning" subcommand
    if (args[0] === "reasoning") {
      const level = args[1];
      const validLevels = ["low", "medium", "high", "disable"] as const;
      if (!level || !validLevels.includes(level as (typeof validLevels)[number])) {
        yield* terminal.error(`Invalid reasoning level. Use: ${validLevels.join(", ")}`);
        yield* terminal.log("");
        return { shouldContinue: true };
      }

      const updatedConfig = {
        ...agent.config,
        reasoningEffort: level as "low" | "medium" | "high" | "disable",
      };
      const newAgent = yield* agentService.updateAgent(agent.id, { config: updatedConfig });
      yield* terminal.success(`Reasoning effort set to: ${level}`);

      // Check if model supports tools and warn if not
      const modelMeta = yield* Effect.promise(() =>
        getModelsDevMetadata(newAgent.config.llmModel, newAgent.config.llmProvider),
      );
      if (
        modelMeta &&
        !modelMeta.supportsTools &&
        newAgent.config.tools &&
        newAgent.config.tools.length > 0
      ) {
        yield* terminal.log("");
        yield* terminal.warn(
          `⚠️  The current model (${newAgent.config.llmModel}) does not support tools. Your configured tools will not be available.`,
        );
      }

      yield* terminal.log("");
      return { shouldContinue: true, newAgent };
    }

    // Handle provider/model argument
    const modelArg = args.join(" ");
    const slashIndex = modelArg.indexOf("/");
    if (slashIndex === -1) {
      yield* terminal.error("Format: /model <provider>/<model>");
      yield* terminal.info("Example: /model openai/gpt-4o");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const providerName = modelArg.substring(0, slashIndex) as ProviderName;
    const modelId = modelArg.substring(slashIndex + 1);

    // Validate provider exists
    if (!AVAILABLE_PROVIDERS.includes(providerName)) {
      yield* terminal.error(`Unknown provider: ${providerName}`);
      yield* terminal.info(`Available: ${AVAILABLE_PROVIDERS.join(", ")}`);
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const updatedConfig = {
      ...agent.config,
      llmProvider: providerName,
      llmModel: modelId,
    };
    const newAgent = yield* agentService.updateAgent(agent.id, { config: updatedConfig });
    yield* terminal.success(`Model switched to: ${providerName}/${modelId}`);

    // Check if model supports tools and warn if not
    const modelMeta = yield* Effect.promise(() =>
      getModelsDevMetadata(newAgent.config.llmModel, newAgent.config.llmProvider),
    );
    if (
      modelMeta &&
      !modelMeta.supportsTools &&
      newAgent.config.tools &&
      newAgent.config.tools.length > 0
    ) {
      yield* terminal.log("");
      yield* terminal.warn(
        `⚠️  The current model (${newAgent.config.llmModel}) does not support tools. Your configured tools will not be available.`,
      );
    }

    yield* terminal.log("");
    return { shouldContinue: true, newAgent };
  });
}

/**
 * Handle /reasoning command - Change reasoning effort for this session only.
 *
 * The level is applied to the live agent for the rest of the session but is
 * never written back to the stored agent config, so it resets on the next
 * session. With no args in an interactive terminal this opens the reasoning
 * picker (an overlay you move through with up/down and accept with enter);
 * with no args in a non-interactive terminal it prints the valid levels.
 */
function handleReasoningCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  const validLevels = ["low", "medium", "high", "disable"] as const;
  const isLevel = (value: string): value is (typeof validLevels)[number] =>
    (validLevels as readonly string[]).includes(value);

  const applyLevel = (level: (typeof validLevels)[number]): CommandResult => {
    // Session-only: override the in-memory agent config without persisting it.
    const newAgent = {
      ...agent,
      config: { ...agent.config, reasoningEffort: level },
    };
    return { shouldContinue: true, newAgent };
  };

  return Effect.gen(function* () {
    if (args.length > 0) {
      const level = args[0] ?? "";
      if (!isLevel(level)) {
        yield* terminal.error(`Invalid reasoning level. Use: ${validLevels.join(", ")}`);
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      yield* terminal.success(`Reasoning effort set to: ${level} (this session only)`);
      yield* terminal.log("");
      return applyLevel(level);
    }

    if (terminal.isInteractive) {
      const selected = yield* terminal.select<(typeof validLevels)[number]>(
        "Set reasoning effort for this session:",
        {
          choices: validLevels.map((level) => ({
            name: level,
            value: level,
            ...(level === (agent.config.reasoningEffort ?? "disable")
              ? { description: "current" }
              : {}),
          })),
          default: agent.config.reasoningEffort ?? "disable",
        },
      );
      if (!selected) {
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      yield* terminal.success(`Reasoning effort set to: ${selected} (this session only)`);
      yield* terminal.log("");
      return applyLevel(selected);
    }

    yield* terminal.log(fmt.heading("Reasoning Effort (this session)"));
    yield* terminal.log(fmt.keyValueCompact("Current", agent.config.reasoningEffort ?? "default"));
    yield* terminal.info(`Levels: ${validLevels.join(", ")}`);
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /config command - Show or modify agent configuration
 */
function handleConfigCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  args: string[],
): Effect.Effect<
  CommandResult,
  StorageError | StorageNotFoundError | Error,
  AgentService | ToolRegistry
> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // "tools" subcommand: show and toggle tools
    if (args[0] === "tools") {
      const toolRegistry = yield* ToolRegistryTag;
      const allToolsByCategory = yield* toolRegistry.listToolsByCategory();
      const allToolNames = Object.values(allToolsByCategory).flat();

      const agentToolNames = normalizeToolConfig(agent.config.tools, { agentId: agent.id });
      const agentToolSet = new Set(agentToolNames);

      const choices = allToolNames.map((tool) => ({
        name: tool,
        value: tool,
      }));

      const selected = yield* terminal.checkbox<string>("Select tools to enable:", {
        choices,
        default: agentToolNames,
      });

      const newTools = [...selected];

      // Report changes
      const added = newTools.filter((t) => !agentToolSet.has(t));
      const removed = agentToolNames.filter((t) => !newTools.includes(t));
      for (const tool of added) {
        yield* terminal.success(`Enabled tool: ${tool}`);
      }
      for (const tool of removed) {
        yield* terminal.success(`Disabled tool: ${tool}`);
      }
      if (added.length === 0 && removed.length === 0) {
        yield* terminal.info("No changes made.");
        return { shouldContinue: true };
      }

      const updatedConfig = { ...agent.config, tools: newTools };
      const newAgent = yield* agentService.updateAgent(agent.id, { config: updatedConfig });
      yield* terminal.log("");
      return { shouldContinue: true, newAgent };
    }

    // No args: show full config
    yield* terminal.log(fmt.heading("Agent Configuration"));
    yield* terminal.log(fmt.keyValueCompact("Name", agent.name));
    if (agent.description) {
      yield* terminal.log(fmt.keyValueCompact("Description", agent.description));
    }
    yield* terminal.log(fmt.keyValueCompact("Persona", agent.config.persona));
    yield* terminal.log(
      fmt.keyValueCompact("Model", `${agent.config.llmProvider}/${agent.config.llmModel}`),
    );
    yield* terminal.log(fmt.keyValueCompact("Reasoning", agent.config.reasoningEffort ?? "—"));

    const agentToolNames = normalizeToolConfig(agent.config.tools, { agentId: agent.id });
    yield* terminal.log(fmt.keyValueCompact("Tools", `${agentToolNames.length} enabled`));
    if (agentToolNames.length > 0) {
      for (const tool of agentToolNames.slice(0, 10)) {
        yield* terminal.log(fmt.item(tool));
      }
      if (agentToolNames.length > 10) {
        yield* terminal.log(fmt.overflow(agentToolNames.length - 10));
      }
    }

    yield* terminal.log(fmt.blank());
    yield* terminal.info("Subcommands: /config tools");
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /clear command - Clear the screen
 */
function handleClearCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    // Use terminal.clear() which both clears the screen and resets the
    // Ink output island state (scrollback buffer: staticEntries + pending).
    yield* terminal.clear();
    yield* terminal.info(`Chat with ${agent.name} - Screen cleared`);
    yield* terminal.info("Type '/help' to see available commands.");
    yield* terminal.info("Type '/exit' to end the conversation.");
    yield* terminal.log("");
    return { shouldContinue: true };
  });
}

/**
 * Handle /workflows command - List available workflows
 */
function handleWorkflowsCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, Error, WorkflowService> {
  return Effect.gen(function* () {
    const workflowService = yield* WorkflowServiceTag;

    yield* terminal.log(fmt.heading("Available Workflows"));

    const workflows = yield* workflowService.listWorkflows();

    if (workflows.length === 0) {
      yield* terminal.info("No workflows found.");
      yield* terminal.log(fmt.blank());
      yield* terminal.info("Create a workflow by adding a WORKFLOW.md file to:");
      yield* terminal.log(fmt.item("./workflows/<name>/WORKFLOW.md (local)"));
      yield* terminal.log(fmt.item("~/.jazz/workflows/<name>/WORKFLOW.md (global)"));
      yield* terminal.info("Or type /workflows create and the agent will guide you.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    const { local, global, builtin } = groupWorkflows(workflows);

    if (local.length > 0) {
      yield* terminal.log(fmt.section("Local", local.length, "workflow"));
      for (const w of local) {
        yield* terminal.log(fmt.itemWithDesc(w.name, formatWorkflowDesc(w)));
      }
      yield* terminal.log(fmt.blank());
    }

    if (global.length > 0) {
      yield* terminal.log(fmt.section("Global", global.length, "workflow"));
      for (const w of global) {
        yield* terminal.log(fmt.itemWithDesc(w.name, formatWorkflowDesc(w)));
      }
      yield* terminal.log(fmt.blank());
    }

    if (builtin.length > 0) {
      yield* terminal.log(fmt.section("Built-in", builtin.length, "workflow"));
      for (const w of builtin) {
        yield* terminal.log(fmt.itemWithDesc(w.name, formatWorkflowDesc(w)));
      }
      yield* terminal.log(fmt.blank());
    }

    yield* terminal.log(fmt.footer(`Total: ${workflows.length} workflow(s)`));
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Build a description string for a workflow that includes the cron schedule
 * and assigned agent when present.
 *
 * Example outputs:
 *   "Daily email digest"
 *   "Daily email digest (every day at 9:00 AM)"
 *   "Daily email digest (every day at 9:00 AM, agent: email-bot)"
 */
function formatWorkflowDesc(w: WorkflowMetadata): string {
  const parts: string[] = [w.description];

  const scheduleDesc = w.schedule ? describeCronSchedule(w.schedule) : null;
  if (w.schedule) {
    parts.push(scheduleDesc ? `(${scheduleDesc})` : `[${w.schedule}]`);
  }
  if (w.agent) {
    parts.push(`(agent: ${w.agent})`);
  }

  return parts.join(" ");
}

/**
 * Handle a skill invoked as a slash command (e.g. `/deep-research <task>`).
 *
 * args[0] is the skill name; the rest is optional trailing text. We hand the
 * invocation to the agent via `resendMessage` so it loads and follows the skill
 * through its existing `load_skill` tool — the same path skills use elsewhere.
 */
function handleRunSkillCommand(args: string[]): Effect.Effect<CommandResult, never, never> {
  return Effect.sync(() => {
    const skillName = args[0] ?? "";
    const trailingText = args.slice(1).join(" ").trim();
    const resendMessage =
      trailingText.length > 0
        ? `Use the "${skillName}" skill to help with: ${trailingText}`
        : `Use the "${skillName}" skill.`;
    return { shouldContinue: true, resendMessage };
  });
}

/**
 * Bind loose slash-command arguments to a prompt's declared parameters.
 *
 * Accepts `name=value` pairs in any order and falls back to positional order
 * for bare words, so both `/srv:issue title=Bug` and `/srv:issue Bug` work.
 * A single bare trailing phrase fills the first declared argument rather than
 * being split, which is what people actually type.
 */
export function bindPromptArguments(
  declared: readonly MCPPromptArgument[],
  args: readonly string[],
): Record<string, string> {
  const bound: Record<string, string> = {};
  const declaredNames = new Set(declared.map((argument) => argument.name));
  const positional: string[] = [];

  for (const arg of args) {
    const separator = arg.indexOf("=");
    const key = separator > 0 ? arg.slice(0, separator) : undefined;
    if (key !== undefined && declaredNames.has(key)) {
      bound[key] = arg.slice(separator + 1);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    const unfilled = declared.filter((argument) => bound[argument.name] === undefined);
    const first = unfilled[0];
    if (unfilled.length === 1 && first) {
      bound[first.name] = positional.join(" ");
    } else {
      unfilled.forEach((argument, index) => {
        const value = positional[index];
        if (value !== undefined) bound[argument.name] = value;
      });
    }
  }

  return bound;
}

/** Flatten a resolved prompt's messages into text to send as the user turn. */
export function flattenPromptMessages(messages: readonly MCPPromptMessage[]): string {
  const parts: string[] = [];

  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (typeof content === "object" && content !== null) {
      const block = content as { type?: string; text?: string; resource?: { text?: string } };
      if (typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      // An embedded resource carries its body here; anything else (images,
      // resource links) has no text form worth inlining.
      if (typeof block.resource?.text === "string") {
        parts.push(block.resource.text);
      }
    }
  }

  return parts.join("\n\n").trim();
}

/**
 * Handle `/server:prompt` — resolve an MCP prompt and send it as the user turn.
 */
function handleRunMcpPromptCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, MCPServerManager | LoggerService> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const commandName = args[0] ?? "";
    const separator = commandName.indexOf(":");

    if (separator <= 0) {
      yield* terminal.error(`Not an MCP prompt: /${commandName}`);
      return { shouldContinue: true };
    }

    const serverName = commandName.slice(0, separator);
    const promptName = commandName.slice(separator + 1);

    const prompts = yield* mcpManager.getServerPrompts(serverName).pipe(Effect.either);
    if (prompts._tag === "Left") {
      yield* terminal.error(prompts.left.reason);
      return { shouldContinue: true };
    }

    const definition = prompts.right.find((prompt) => prompt.name === promptName);
    if (!definition) {
      yield* terminal.error(`${serverName} does not advertise a prompt named "${promptName}".`);
      return { shouldContinue: true };
    }

    const declared = definition.arguments ?? [];
    const bound: Record<string, string> = { ...bindPromptArguments(declared, args.slice(1)) };

    // Rather than rejecting an under-specified invocation, ask for what is
    // missing — offering the server's own completions where it implements
    // them, which is the only place completion/complete is reachable without
    // an autocomplete-aware composer.
    for (const argument of declared) {
      if (bound[argument.name] !== undefined) continue;
      if (argument.required !== true) continue;

      const label = argument.description
        ? `${argument.name} — ${argument.description}`
        : argument.name;

      const suggestions = yield* mcpManager.completeArgument(
        serverName,
        { type: "prompt", name: promptName },
        argument.name,
        "",
        bound,
      );

      if (suggestions.length > 0) {
        const chosen = yield* terminal.select<string>(label, {
          choices: suggestions.map((value) => ({ name: value, value })),
        });
        if (!chosen) {
          yield* terminal.info("Cancelled.");
          return { shouldContinue: true };
        }
        bound[argument.name] = chosen;
        continue;
      }

      const typed = yield* terminal.ask(label, { cancellable: true });
      if (typed === undefined || typed.trim() === "") {
        yield* terminal.info("Cancelled.");
        return { shouldContinue: true };
      }
      bound[argument.name] = typed.trim();
    }

    const resolved = yield* mcpManager.getPrompt(serverName, promptName, bound).pipe(Effect.either);
    if (resolved._tag === "Left") {
      yield* terminal.error(resolved.left.reason);
      return { shouldContinue: true };
    }

    const text = flattenPromptMessages(resolved.right.messages);

    if (text === "") {
      yield* terminal.warn(`Prompt "${promptName}" resolved to no text content.`);
      return { shouldContinue: true };
    }

    return { shouldContinue: true, resendMessage: text };
  });
}

/**
 * Handle unknown command
 */
function handleUnknownCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.error(`Unknown command: /${args.join(" ")}`);
    yield* terminal.info("Type '/help' to see available commands.");
    yield* terminal.log("");
    return { shouldContinue: true };
  });
}

function handleResumeCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
): Effect.Effect<CommandResult, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const history = yield* loadHistory(agent.id).pipe(
      Effect.catchAll(() => Effect.succeed({ agentId: agent.id, conversations: [] })),
    );

    if (history.conversations.length === 0) {
      yield* terminal.info("No past conversations found for this agent.");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const choices = history.conversations.map((conv) => {
      const date = new Date(conv.startedAt);
      const dateStr = date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      return {
        name: `${conv.title}  (${dateStr}, ${conv.messageCount} messages)`,
        value: conv.conversationId,
      };
    });

    const selectedId = yield* terminal.search<string>("Select a conversation to resume:", {
      choices,
      placeholder: "Type to filter conversations…",
    });

    if (!selectedId) {
      yield* terminal.log("Resume cancelled");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const selected = history.conversations.find((c) => c.conversationId === selectedId);
    if (!selected) {
      return { shouldContinue: true };
    }

    // The listing carries no transcript, so the chosen conversation is read now rather
    // than every conversation being read to draw the picker.
    const conversation = yield* loadConversation(agent.id, selected.conversationId).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (!conversation) {
      yield* terminal.info("That conversation could no longer be read.");
      return { shouldContinue: true };
    }

    const resumeSystemMessage = {
      role: "system" as const,
      content: `Resuming conversation from ${new Date(selected.startedAt).toLocaleString()}: ${selected.title}`,
    };

    // Logs no longer hold system prompts; the live one is rebuilt for this run anyway.
    const newHistory = [resumeSystemMessage, ...conversation.messages];

    yield* terminal.success(`Resumed: ${selected.title}`);
    yield* terminal.log("");
    return { shouldContinue: true, newHistory, saveCurrentHistory: true, resetStartedAt: true };
  });
}

/**
 * Handle /skills command - List and view skills
 */
function handleSkillsCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, Error, SkillService> {
  return Effect.gen(function* () {
    const skillService = yield* SkillServiceTag;
    const { builtin, global, agents, local } = yield* skillService.listSkillsBySource();

    const totalCount = builtin.length + global.length + agents.length + local.length;

    if (totalCount === 0) {
      yield* terminal.warn("No skills found.");
      yield* terminal.log(fmt.blank());
      yield* terminal.info("Create a skill by adding a SKILL.md file to:");
      yield* terminal.log(fmt.item("./skills/<name>/SKILL.md (local)"));
      yield* terminal.log(fmt.item("~/.jazz/skills/<name>/SKILL.md (global)"));
      yield* terminal.log(fmt.item("~/.agents/skills/<name>/SKILL.md (shared agents)"));
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    yield* terminal.log(fmt.heading("Available Skills"));

    let sourcesCount = 0;

    if (builtin.length > 0) {
      sourcesCount++;
      const sorted = [...builtin].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Built-in", builtin.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    if (global.length > 0) {
      sourcesCount++;
      const sorted = [...global].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Global", global.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    if (agents.length > 0) {
      sourcesCount++;
      const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Agents", agents.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    if (local.length > 0) {
      sourcesCount++;
      const sorted = [...local].sort((a, b) => a.name.localeCompare(b.name));
      yield* terminal.log(fmt.section("Local", local.length, "skill"));
      for (const s of sorted) {
        yield* terminal.log(fmt.itemWithDesc(s.name, s.description));
      }
      yield* terminal.log(fmt.blank());
    }

    yield* terminal.log(
      fmt.footer(
        `Total: ${totalCount} ${totalCount === 1 ? "skill" : "skills"} across ${sourcesCount} ${sourcesCount === 1 ? "source" : "sources"}`,
      ),
    );
    yield* terminal.log(fmt.blank());

    return { shouldContinue: true };
  });
}

/**
 * Handle /stats command - Show session statistics and usage summary
 */
function handleStatsCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  context: CommandContext,
): Effect.Effect<CommandResult, never, FileSystemContextService> {
  return Effect.gen(function* () {
    yield* terminal.log(fmt.heading("Session Statistics"));

    // Session duration
    const now = new Date();
    const elapsed = now.getTime() - context.sessionStartedAt.getTime();
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const durationParts: string[] = [];
    if (hours > 0) durationParts.push(`${hours}h`);
    if (minutes % 60 > 0 || hours > 0) durationParts.push(`${minutes % 60}m`);
    durationParts.push(`${seconds % 60}s`);
    const duration = durationParts.join(" ");

    yield* terminal.log(fmt.keyValueCompact("Agent", `${agent.name} (${agent.id})`));
    yield* terminal.log(
      fmt.keyValueCompact("Model", `${agent.config.llmProvider}/${agent.config.llmModel}`),
    );
    yield* terminal.log(
      fmt.keyValueCompact("Reasoning", agent.config.reasoningEffort ?? "default"),
    );
    const totalTools = agent.config.tools?.length ?? 0;
    yield* terminal.log(fmt.keyValueCompact("Tools", `${totalTools} available`));

    const fileSystemContext = yield* FileSystemContextServiceTag;
    const workingDirectory = yield* fileSystemContext.getCwd(
      context.conversationId
        ? { agentId: agent.id, conversationId: context.conversationId }
        : { agentId: agent.id },
    );
    yield* terminal.log(fmt.keyValueCompact("Directory", workingDirectory));

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.keyValueCompact("Duration", duration));
    yield* terminal.log(fmt.keyValueCompact("Messages", `${context.conversationHistory.length}`));

    const { promptTokens, completionTokens } = context.sessionUsage;
    const totalTokens = promptTokens + completionTokens;
    yield* terminal.log(
      fmt.keyValueCompact(
        "Tokens",
        `${totalTokens.toLocaleString()} (in: ${promptTokens.toLocaleString()}, out: ${completionTokens.toLocaleString()})`,
      ),
    );

    // Estimated cost
    const meta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
    );
    const inputPricePerMillion = meta?.inputPricePerMillion ?? 0;
    const outputPricePerMillion = meta?.outputPricePerMillion ?? 0;
    const inputCost = (promptTokens / 1_000_000) * inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * outputPricePerMillion;
    const totalCost = inputCost + outputCost;
    yield* terminal.log(fmt.keyValueCompact("Est. cost", formatUsd(totalCost)));

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle `/mcp` — show server status, and `/mcp reconnect <name>` to retry one.
 *
 * Reconnect exists because a server that failed at startup was otherwise
 * unreachable for the rest of the session: the only fix was to quit, repair it,
 * and start the conversation over.
 */
function handleMcpCommand(
  terminal: TerminalService,
  args: readonly string[] = [],
): Effect.Effect<CommandResult, never, MCPServerManager | AgentConfigService | LoggerService> {
  return Effect.gen(function* () {
    const mcpManager = yield* MCPServerManagerTag;
    const servers = yield* mcpManager.listServers();

    const [subcommand, targetName] = args;

    if (subcommand === "reconnect") {
      const target = servers.find((server) => server.name === targetName);
      if (!target) {
        yield* terminal.error(
          targetName === undefined
            ? "Usage: /mcp reconnect <server>"
            : `No MCP server named "${targetName}".`,
        );
        return { shouldContinue: true };
      }

      yield* mcpManager.disconnectServer(target.name).pipe(Effect.catchAll(() => Effect.void));
      const reconnected = yield* mcpManager.connectServer(target).pipe(Effect.either);

      if (reconnected._tag === "Left") {
        yield* terminal.error(reconnected.left.reason);
        if (reconnected.left.suggestion) {
          yield* terminal.info(reconnected.left.suggestion);
        }
        return { shouldContinue: true };
      }

      const tools = yield* mcpManager.getServerTools(target.name).pipe(Effect.either);
      yield* terminal.success(
        `Reconnected to ${target.name}${tools._tag === "Right" ? ` (${tools.right.length} tool(s))` : ""}`,
      );
      return { shouldContinue: true };
    }

    yield* terminal.log(fmt.heading("MCP Servers"));

    if (servers.length === 0) {
      yield* terminal.info("No MCP servers configured.");
      yield* terminal.log(fmt.keyValueCompact("Config", "~/.agents/mcp.json"));
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    for (const server of servers) {
      const connected = yield* mcpManager.isConnected(server.name);
      const enabledStr = server.enabled === false ? "disabled" : "enabled";
      const connectedStr = connected ? "connected" : "disconnected";

      yield* terminal.log(
        connected ? fmt.statusConnected(server.name) : fmt.statusDisconnected(server.name),
      );
      yield* terminal.log(fmt.keyValue("Status", `${enabledStr}, ${connectedStr}`));
      yield* terminal.log(fmt.keyValue("Transport", server.transport ?? "stdio"));
      // Trust decides whether this server's tools can skip approval prompts, so
      // it belongs next to the connection state rather than buried in config.
      yield* terminal.log(
        fmt.keyValue("Trust", server.trusted === true ? "trusted" : "asks every call"),
      );

      if (isStdioConfig(server)) {
        const cmd = `${server.command}${server.args?.length ? " " + server.args.join(" ") : ""}`;
        yield* terminal.log(fmt.keyValue("Command", cmd));
      } else if (isHttpConfig(server)) {
        yield* terminal.log(fmt.keyValue("URL", server.url));
      }

      if (connected) {
        const tools = yield* mcpManager.getServerTools(server.name).pipe(Effect.either);
        if (tools._tag === "Right") {
          yield* terminal.log(fmt.keyValue("Tools", String(tools.right.length)));
        }
        const prompts = yield* mcpManager.getServerPrompts(server.name).pipe(Effect.either);
        if (prompts._tag === "Right" && prompts.right.length > 0) {
          yield* terminal.log(
            fmt.keyValue(
              "Prompts",
              prompts.right.map((prompt) => `/${server.name}:${prompt.name}`).join(", "),
            ),
          );
        }
      }

      yield* terminal.log(fmt.blank());
    }

    yield* terminal.log(fmt.footer(`Total: ${servers.length} server(s)`));
    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}

/**
 * Handle /mode command - Switch between safe mode and yolo mode
 */
function handleModeCommand(
  terminal: TerminalService,
  args: string[],
  currentPolicy?: AutoApprovePolicy,
  autoApprovedCommands?: readonly string[],
  persistedAutoApprovedCommands?: readonly string[],
  autoApprovedTools?: readonly string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    const modeArg = args[0]?.toLowerCase();

    if (modeArg === "allow") {
      const pattern = args.slice(1).join(" ").trim();
      if (!pattern) {
        yield* terminal.error("Usage: /mode allow <command prefix>");
        yield* terminal.info("Example: /mode allow git status");
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      yield* terminal.success(`Auto-approving command: ${pattern}`);
      yield* terminal.log("");
      return { shouldContinue: true, addAutoApprovedCommand: pattern };
    }

    if (modeArg === "disallow") {
      const pattern = args.slice(1).join(" ").trim();
      if (!pattern) {
        yield* terminal.error("Usage: /mode disallow <command prefix>");
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      yield* terminal.success(`Removed auto-approval for: ${pattern}`);
      yield* terminal.log("");
      return { shouldContinue: true, removeAutoApprovedCommand: pattern };
    }

    if (modeArg === "safe") {
      yield* terminal.success("Switched to safe mode — all tool calls require approval");
      yield* terminal.log("");
      return { shouldContinue: true, newAutoApprovePolicy: false as const };
    }

    if (modeArg === "yolo") {
      yield* terminal.success("Switched to yolo mode — all tool calls auto-approved");
      yield* terminal.log("");
      return { shouldContinue: true, newAutoApprovePolicy: true as const };
    }

    if (modeArg) {
      yield* terminal.error(`Unknown mode: ${modeArg}`);
      yield* terminal.info("Available modes: safe, yolo, allow <cmd>, disallow <cmd>");
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    // Interactive: show select prompt. Surface the allow/disallow
    // sub-commands here — previously they were only discoverable via the
    // error path.
    yield* terminal.log(
      fmt.footer(
        "Tip: /mode allow <cmd> auto-approves a command prefix; /mode disallow removes it.",
      ),
    );
    const isSafe = !currentPolicy;
    const isYolo = currentPolicy === true || currentPolicy === "high-risk";
    const selected = yield* terminal.select<string>("Select tool approval mode:", {
      choices: [
        {
          name: `safe — require approval for every tool call${isSafe ? " (current)" : ""}`,
          value: "safe",
        },
        { name: `yolo — auto-approve all tool calls${isYolo ? " (current)" : ""}`, value: "yolo" },
      ],
    });

    // Show auto-approved commands if any
    if (autoApprovedCommands?.length) {
      const persistedSet = new Set(persistedAutoApprovedCommands ?? []);
      yield* terminal.log(fmt.blank());
      yield* terminal.log(fmt.section("Auto-approved Commands"));
      for (const cmd of autoApprovedCommands) {
        const suffix = persistedSet.has(cmd) ? "(always)" : "(session)";
        yield* terminal.log(fmt.itemWithDesc(cmd, suffix));
      }
    }

    // Show auto-approved tools if any
    if (autoApprovedTools?.length) {
      yield* terminal.log(fmt.blank());
      yield* terminal.log(fmt.section("Auto-approved Tools"));
      for (const tool of autoApprovedTools) {
        yield* terminal.log(fmt.item(tool));
      }
    }

    if (!selected) {
      return { shouldContinue: true };
    }

    if (selected === "yolo") {
      yield* terminal.success("Switched to yolo mode — all tool calls auto-approved");
      yield* terminal.log("");
      return { shouldContinue: true, newAutoApprovePolicy: true as const };
    }

    yield* terminal.success("Switched to safe mode — all tool calls require approval");
    yield* terminal.log("");
    return { shouldContinue: true, newAutoApprovePolicy: false as const };
  });
}

// ============================================================================
// Context Command Utilities
// ============================================================================

/**
 * Symbols for context visualization. Resolved per call so the glyph mode
 * (unicode block shades vs portable ASCII) is honored at render time.
 */
function contextSymbols(): { used: string; free: string; buffer: string } {
  const glyphs = getGlyphs();
  return {
    used: glyphs.gridFilled,
    free: glyphs.gridEmpty,
    buffer: glyphs.gridReserved,
  };
}

/** Grid dimensions for visualization (10x10 = 100 cells) */
const GRID_SIZE = 10;
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;

/**
 * Space reserved for autocompact: whatever sits above the ratio at which compaction
 * actually fires, so the grid and the runtime agree on where the ceiling is.
 */
function autocompactBufferPercent(compactThresholdRatio: number): number {
  return 1 - compactThresholdRatio;
}

/**
 * Get the model's advertised context window from models.dev, or `undefined` when
 * the catalog does not know the model — the catalog carries no local-provider
 * entries, and a placeholder maximum must not be mistaken for a real one.
 * Pass provider when known so provider-scoped metadata is used
 * otherwise model-only lookup can return another provider's limits.
 */
function getModelContextWindowEffect(
  modelId: string,
  providerId?: string,
): Effect.Effect<number | undefined, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const meta = await getModelsDevMetadata(modelId, providerId);
      return meta?.contextWindow;
    },
    catch: () => new Error("Failed to fetch model metadata"),
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

/**
 * Estimate tokens for a message
 */
function estimateMessageTokens(message: ChatMessage): number {
  let contentTokens = 0;
  if (message.content) {
    contentTokens = Math.ceil(message.content.length / 4);
  }

  let toolTokens = 0;
  if (message.tool_calls) {
    toolTokens = Math.ceil(JSON.stringify(message.tool_calls).length / 4);
  } else if (message.role === "tool" && message.tool_call_id) {
    toolTokens = 10;
  }

  return contentTokens + toolTokens + 4;
}

/**
 * Format token count for display (e.g., 18000 -> "18k", 150000 -> "150k")
 */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

/**
 * Calculate context usage breakdown
 */
interface ContextUsageBreakdown {
  systemPromptTokens: number;
  toolsTokens: number;
  skillsTokens: number;
  messagesTokens: number;
  totalUsed: number;
  freeSpace: number;
  autocompactBuffer: number;
  contextWindow: number;
}

function calculateContextUsage(
  conversationHistory: ChatMessage[],
  contextWindow: number,
  compactThresholdRatio: number,
): ContextUsageBreakdown {
  // Calculate autocompact buffer (reserved space)
  const autocompactBuffer = Math.floor(
    contextWindow * autocompactBufferPercent(compactThresholdRatio),
  );
  const effectiveWindow = contextWindow - autocompactBuffer;

  // Separate system message from other messages
  const systemMessage = conversationHistory.find((m) => m.role === "system");
  const otherMessages = conversationHistory.filter((m) => m.role !== "system");

  // Estimate system prompt tokens, separating out the skills catalog
  let systemPromptTokens = systemMessage ? estimateMessageTokens(systemMessage) : 0;
  let skillsTokens = 0;

  // Extract skill catalog tokens from system prompt
  if (systemMessage?.content) {
    const skillsMatch = systemMessage.content.match(
      /\nSkills:\n[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>\n/,
    );
    if (skillsMatch) {
      const catalogTokens = Math.ceil(skillsMatch[0].length / 4);
      skillsTokens += catalogTokens;
      systemPromptTokens -= catalogTokens;
    }
  }

  // Tool tokens are estimated from tool calls in messages
  let toolsTokens = 0;
  let messagesTokens = 0;

  for (const msg of otherMessages) {
    const tokens = estimateMessageTokens(msg);
    if (msg.role === "tool" && (msg.name === "load_skill" || msg.name === "load_skill_section")) {
      // Loaded skill content counts as skills, not tools
      skillsTokens += tokens;
    } else if (msg.role === "tool" || (msg.role === "assistant" && msg.tool_calls)) {
      toolsTokens += tokens;
    } else {
      messagesTokens += tokens;
    }
  }

  const totalUsed = systemPromptTokens + toolsTokens + skillsTokens + messagesTokens;
  const freeSpace = Math.max(0, effectiveWindow - totalUsed);

  return {
    systemPromptTokens,
    toolsTokens,
    skillsTokens,
    messagesTokens,
    totalUsed,
    freeSpace,
    autocompactBuffer,
    contextWindow,
  };
}

/**
 * Generate the visual context grid
 */
function generateContextGrid(usage: ContextUsageBreakdown): string[] {
  const { totalUsed, freeSpace, autocompactBuffer, contextWindow } = usage;

  // Calculate cell allocations
  const usedCells = Math.round((totalUsed / contextWindow) * TOTAL_CELLS);
  const freeCells = Math.round((freeSpace / contextWindow) * TOTAL_CELLS);
  const bufferCells = Math.round((autocompactBuffer / contextWindow) * TOTAL_CELLS);

  // Ensure we fill exactly 100 cells
  const adjusted = usedCells + freeCells + bufferCells;
  let adjustedFreeCells = freeCells;
  if (adjusted !== TOTAL_CELLS) {
    adjustedFreeCells = TOTAL_CELLS - usedCells - bufferCells;
  }

  // Build the grid string
  const symbols = contextSymbols();
  const cells: string[] = [];
  for (let i = 0; i < usedCells; i++) cells.push(symbols.used);
  for (let i = 0; i < Math.max(0, adjustedFreeCells); i++) cells.push(symbols.free);
  for (let i = 0; i < bufferCells; i++) cells.push(symbols.buffer);

  // Pad or trim to exactly 100 cells
  while (cells.length < TOTAL_CELLS) cells.push(symbols.free);
  cells.length = TOTAL_CELLS;

  // Format into rows
  const rows: string[] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    const rowCells = cells.slice(row * GRID_SIZE, (row + 1) * GRID_SIZE);
    rows.push(rowCells.join(" "));
  }

  return rows;
}

/**
 * Handle /work command — show or discard the working state kept for this conversation.
 *
 * Working state is written by compaction and by the agent itself, so without a way to
 * read it you cannot tell whether what a resumed session "remembers" is accurate, and
 * without a way to clear it a stale record follows the conversation forever.
 */
function handleWorkCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  conversationId: string | undefined,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    if (!conversationId) {
      yield* terminal.info("No active conversation, so there is no working state.");
      return { shouldContinue: true };
    }

    if (args[0] === "clear") {
      const cleared = yield* clearWorkState(agent.id, conversationId);
      yield* terminal.log(
        cleared ? fmt.heading("Working state cleared") : "Nothing to clear for this conversation.",
      );
      return { shouldContinue: true };
    }

    const state = yield* readWorkState(agent.id, conversationId);
    const entries = yield* readJournal(agent.id, conversationId);
    const sizeBytes = yield* workStateSizeBytes(agent.id, conversationId);

    yield* terminal.log(fmt.heading("Working state"));

    const formatted = formatWorkState(state);
    if (formatted) {
      yield* terminal.log(`\n${formatted}`);
    } else {
      yield* terminal.log("\nNo task state recorded yet.");
    }

    if (entries.length > 0) {
      yield* terminal.log(
        `\n${entries.length} compaction record(s), most recent ${entries[entries.length - 1]?.recordedAt}.`,
      );
      const latest = entries[entries.length - 1];
      if (latest) {
        const preview =
          latest.summary.length > 500 ? `${latest.summary.slice(0, 500)}…` : latest.summary;
        yield* terminal.log(`\n${preview}`);
      }
    } else {
      yield* terminal.log("\nNo compaction has happened in this conversation yet.");
    }

    yield* terminal.log(
      `\n${(sizeBytes / 1024).toFixed(1)}KB stored. Use \`/work clear\` to discard it.`,
    );

    return { shouldContinue: true };
  });
}

/**
 * Handle /context command - Show context window usage
 */
function handleContextCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  conversationHistory: CommandContext["conversationHistory"],
): Effect.Effect<CommandResult, never, ToolRegistry | AgentConfigService> {
  return Effect.gen(function* () {
    const toolRegistry = yield* ToolRegistryTag;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const { compactThresholdRatio } = resolveContextThresholds(appConfig.context);

    // Get model information
    const provider = agent.config.llmProvider;
    const modelId = agent.config.llmModel;
    const advertisedContextWindow = yield* getModelContextWindowEffect(modelId, provider);
    const effectiveContextWindow = resolveEffectiveContextWindow({
      provider,
      ...(advertisedContextWindow !== undefined && { modelMaxTokens: advertisedContextWindow }),
      ...(typeof agent.config.numCtx === "number" && {
        pinnedContextWindow: agent.config.numCtx,
      }),
      ...(typeof agent.config.maxContextTokens === "number" && {
        agentMaxTokens: agent.config.maxContextTokens,
      }),
    });
    const contextWindow = effectiveContextWindow.tokens;

    // Prefer the overhead the provider actually reported (tool schemas plus its own
    // scaffolding) so this display matches the number that triggers compaction.
    // Fall back to estimating from the schemas before any usage report has arrived.
    const toolDefinitions = yield* toolRegistry.getToolDefinitions();
    const toolDefinitionsJson = JSON.stringify(toolDefinitions);
    const measuredOverhead = DEFAULT_TOKEN_COUNTER.overheadFor({ provider, modelId });
    const toolDefinitionTokens =
      measuredOverhead > 0 ? measuredOverhead : Math.ceil(toolDefinitionsJson.length / 4);

    // Calculate usage breakdown
    const usage = calculateContextUsage(conversationHistory, contextWindow, compactThresholdRatio);

    // Add tool definition tokens (these are sent with every request)
    const adjustedUsage: ContextUsageBreakdown = {
      ...usage,
      toolsTokens: usage.toolsTokens + toolDefinitionTokens,
      totalUsed: usage.totalUsed + toolDefinitionTokens,
      freeSpace: Math.max(0, usage.freeSpace - toolDefinitionTokens),
    };

    // Calculate percentages
    const usagePercent = Math.round((adjustedUsage.totalUsed / contextWindow) * 100);
    const systemPercent = ((adjustedUsage.systemPromptTokens / contextWindow) * 100).toFixed(1);
    const toolsPercent = ((adjustedUsage.toolsTokens / contextWindow) * 100).toFixed(1);
    const skillsPercent = ((adjustedUsage.skillsTokens / contextWindow) * 100).toFixed(1);
    const messagesPercent = ((adjustedUsage.messagesTokens / contextWindow) * 100).toFixed(1);
    const freePercent = ((adjustedUsage.freeSpace / contextWindow) * 100).toFixed(1);
    const bufferPercent = ((adjustedUsage.autocompactBuffer / contextWindow) * 100).toFixed(1);

    // Generate visual grid
    const gridRows = generateContextGrid(adjustedUsage);
    const symbols = contextSymbols();

    // Display header
    yield* terminal.log(fmt.heading("Context Usage"));

    // Display model info and total usage on first row
    const modelDisplay = `${provider}/${modelId}`;
    const modelMaxTokens = effectiveContextWindow.modelMaxTokens;
    const runtimeWindowNote = effectiveContextWindow.cappedByAgent
      ? ` · agent max context${modelMaxTokens !== undefined ? `, model max ${formatTokenCount(modelMaxTokens)}` : ""}`
      : modelMaxTokens !== undefined && effectiveContextWindow.tokens < modelMaxTokens
        ? ` · runtime window, model max ${formatTokenCount(modelMaxTokens)}`
        : "";
    const usageDisplay = `${formatTokenCount(adjustedUsage.totalUsed)}/${formatTokenCount(contextWindow)} tokens (${usagePercent}%)${runtimeWindowNote}`;

    yield* terminal.log(`   ${gridRows[0]}   ${modelDisplay} · ${usageDisplay}`);
    yield* terminal.log(`   ${gridRows[1]}`);
    yield* terminal.log(`   ${gridRows[2]}   Estimated usage by category`);
    yield* terminal.log(
      `   ${gridRows[3]}   ${symbols.used} System prompt: ${formatTokenCount(adjustedUsage.systemPromptTokens)} tokens (${systemPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[4]}   ${symbols.used} System tools: ${formatTokenCount(adjustedUsage.toolsTokens)} tokens (${toolsPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[5]}   ${symbols.used} Skills: ${formatTokenCount(adjustedUsage.skillsTokens)} tokens (${skillsPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[6]}   ${symbols.used} Messages: ${formatTokenCount(adjustedUsage.messagesTokens)} tokens (${messagesPercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[7]}   ${symbols.free} Free space: ${formatTokenCount(adjustedUsage.freeSpace)} (${freePercent}%)`,
    );
    yield* terminal.log(
      `   ${gridRows[8]}   ${symbols.buffer} Autocompact buffer: ${formatTokenCount(adjustedUsage.autocompactBuffer)} tokens (${bufferPercent}%)`,
    );
    yield* terminal.log(`   ${gridRows[9]}`);
    yield* terminal.log("");

    return { shouldContinue: true };
  });
}

/**
 * Format a small USD amount for display (e.g. 0.0012 → "$0.0012", 0 → "$0.00").
 */
function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return `$${amount.toExponential(2)}`;
}

/**
 * Handle /cost command - Show conversation token usage and estimated cost
 */
function handleCostCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  sessionUsage: { promptTokens: number; completionTokens: number },
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.log(fmt.heading("Conversation Cost"));

    const { promptTokens, completionTokens } = sessionUsage;
    const totalTokens = promptTokens + completionTokens;

    yield* terminal.log(
      fmt.keyValueCompact("Model", `${agent.config.llmProvider}/${agent.config.llmModel}`),
    );
    yield* terminal.log(fmt.keyValueCompact("Input tokens", promptTokens.toLocaleString()));
    yield* terminal.log(fmt.keyValueCompact("Output tokens", completionTokens.toLocaleString()));
    yield* terminal.log(fmt.keyValueCompact("Total tokens", totalTokens.toLocaleString()));

    if (totalTokens === 0) {
      yield* terminal.log(fmt.blank());
      yield* terminal.info("No tokens used yet in this conversation.");
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    const meta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider),
    );

    const inputPricePerMillion = meta?.inputPricePerMillion ?? 0;
    const outputPricePerMillion = meta?.outputPricePerMillion ?? 0;

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.section("Pricing", undefined, undefined));
    yield* terminal.log(fmt.keyValue("Input", `$${inputPricePerMillion.toFixed(2)}/1M tokens`));
    yield* terminal.log(fmt.keyValue("Output", `$${outputPricePerMillion.toFixed(2)}/1M tokens`));

    const inputCost = (promptTokens / 1_000_000) * inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * outputPricePerMillion;
    const totalCost = inputCost + outputCost;

    yield* terminal.log(fmt.blank());
    yield* terminal.log(fmt.section("Estimated Cost"));
    yield* terminal.log(fmt.keyValue("Input", formatUsd(inputCost)));
    yield* terminal.log(fmt.keyValue("Output", formatUsd(outputCost)));
    yield* terminal.log(fmt.keyValue("Total", formatUsd(totalCost)));

    if (meta?.inputPricePerMillion === undefined && meta?.outputPricePerMillion === undefined) {
      yield* terminal.log(fmt.blank());
      yield* terminal.warn(
        "Pricing not available for this model on models.dev; total shown as $0.00.",
      );
    }

    yield* terminal.log(fmt.blank());
    return { shouldContinue: true };
  });
}
