/**
 * Execute parsed chat commands through shared application services. handleSpecialCommand
 * returns explicit session changes for the chat loop to apply; title edits persist before
 * reporting success, agent creation leaves the active conversation in place, and /start
 * requests a fresh conversation after saving the current one. Local command output stays in
 * the UI transcript rather than being inserted into model context unless a command opts in.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { FileSystem } from "@effect/platform";
import { loadConversationOrNull } from "@jazz/adapters/history/conversation-history-service";
import { getLogsDirectory } from "@jazz/adapters/logger";
import { authorizeServer, clearServerAuth, hasStoredAuth } from "@jazz/adapters/mcp/oauth";
import {
  AgentRunner,
  resolveLlamaCppServerModel,
  resolveSglangServerModel,
  resolveVllmServerModel,
} from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { sortAgents } from "@jazz/core/agent/agent-sort";
import { resolveContextThresholds } from "@jazz/core/agent/context/context-thresholds";
import { resolveEffectiveContextWindow } from "@jazz/core/agent/context/effective-context-window";
import type {
  CompactionProgress,
  CompactionProgressObserver,
} from "@jazz/core/agent/context/summarizer";
import { DEFAULT_TOKEN_COUNTER } from "@jazz/core/agent/context/token-counter";
import {
  clearWorkState,
  readJournal,
  workStateSizeBytes,
} from "@jazz/core/agent/context/work-journal";
import { formatWorkState, readWorkState } from "@jazz/core/agent/context/work-state";
import { matchForbiddenCommand, runShellCommand } from "@jazz/core/agent/tools/shell";
import { BUILTIN_TOOL_CATEGORIES } from "@jazz/core/agent/tools/tool-categories";
import { toolKnownSecrets } from "@jazz/core/agent/tools/tool-secrets";
import { WEB_SEARCH_PROVIDERS } from "@jazz/core/agent/tools/web-search";
import { normalizeToolConfig } from "@jazz/core/agent/utils/tool-config";
import { effectiveMemoryScopes } from "@jazz/core/constants/memory";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import {
  FileSystemContextServiceTag,
  type FileSystemContextService,
} from "@jazz/core/interfaces/fs";
import { type JazzStateService } from "@jazz/core/interfaces/jazz-state";
import { LLMServiceTag, type LLMService } from "@jazz/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import {
  MCPServerManagerTag,
  isHttpConfig,
  isStdioConfig,
  type MCPServerConfig,
  type MCPServerManager,
} from "@jazz/core/interfaces/mcp-server";
import { MemoryServiceTag, type MemoryService } from "@jazz/core/interfaces/memory-service";
import { PersonaServiceTag, type PersonaService } from "@jazz/core/interfaces/persona-service";
import { PluginRuntimeServiceTag } from "@jazz/core/interfaces/plugin-runtime";
import {
  PresentationServiceTag,
  type PresentationService,
} from "@jazz/core/interfaces/presentation";
import {
  report,
  TerminalServiceTag,
  type ReportMarker,
  type ReportRow,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@jazz/core/interfaces/tool-registry";
import { redactSecretText } from "@jazz/core/secrets/redaction";
import { SkillServiceTag, type SkillService } from "@jazz/core/skills/skill-service";
import { StorageError, StorageNotFoundError } from "@jazz/core/types/errors";
import type { MCPPromptArgument, MCPPromptMessage } from "@jazz/core/types/mcp";
import type { ChatMessage, ConversationMessages } from "@jazz/core/types/message";
import { clampReasoningSelection } from "@jazz/core/types/model-capabilities";
import type { AutoApprovePolicy } from "@jazz/core/types/tools";
import { describeCronSchedule } from "@jazz/core/utils/cron";
import { createSanitizedEnv } from "@jazz/core/utils/env";
import { toError } from "@jazz/core/utils/errors";
import { conversationLogGroup } from "@jazz/core/utils/log-group";
import { getModelsDevMetadata } from "@jazz/core/utils/models-dev";
import { buildModelChoices } from "@jazz/core/utils/provider-picker";
import { abbreviateHomePath } from "@jazz/core/utils/storage";
import { closestMatch, formatCompactCount } from "@jazz/core/utils/string";
import type { WorkflowMetadata } from "@jazz/core/workflows/workflow-service";
import { WorkflowServiceTag, type WorkflowService } from "@jazz/core/workflows/workflow-service";
import { groupWorkflows } from "@jazz/core/workflows/workflow-utils";
import { Effect, Option } from "effect";
import {
  chatModeForPolicy,
  policyForChatMode,
  type ChatApprovalMode,
} from "@/cli/chat/approval-mode";
import { createAgentCommand } from "@/cli/commands/create-agent";
import { describeTier } from "@/cli/commands/peers";
import { sessionOpenLine } from "@/cli/commands/session-open";
import {
  cancelDetachTransfer,
  commitDetachTransfer,
  DetachCommitError,
  prepareDetachTransfer,
} from "@/cli/detach/orchestrator";
import {
  describeReasoningAdjustment,
  isCliReasoningValue,
  promptForReasoningSelection,
  reasoningChoicesFor,
  reasoningSelectionFromCliValue,
  reasoningSelectionToCliValue,
  type CliReasoningValue,
} from "@/cli/helpers/reasoning";
import { getGlyphs } from "@/cli/ui/glyphs";
import { activeKeymapMode, bindingLabel, KEYMAPS } from "@/cli/ui/keymaps";
import { store } from "@/cli/ui/store";
import { applyTheme, listThemes, themeWarnings, type ThemeListing } from "@/cli/ui/theme";
import { pickThemeInteractively } from "@/cli/ui/theme-picker-prompt";
import { getUserThemesDirectory } from "@/cli/ui/themes/registry";
import * as fmt from "@/cli/utils/list-format";
import { truncate } from "@/cli/utils/string-utils";
import {
  CHAT_COMMANDS,
  commandUsage,
  commandSignature,
  findBuiltinCommand,
  findCommand,
  registeredCommands,
  SHELL_ESCAPE_FORM,
  suggestCommand,
  type ChatCommandInfo,
} from "./constants";
import {
  handleRenameCommand,
  handleStartCommand,
  handleForkCommand,
  handleResumeCommand,
} from "./conversation";
import { handleGoalCommand } from "./goal";
import { handleLoopCommand } from "./loop";
import {
  confirmSessionLimitOverage,
  estimateSessionCostUSD,
  findExceededSessionLimits,
  formatSessionLimitMetric,
  SESSION_LIMIT_FIELD,
  type SessionLimitMetric,
} from "./session-limits";
import type { CommandContext, CommandResult, SessionLimits, SpecialCommand } from "./types";
import { formatCost } from "../../ui/text/format";

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
  | JazzStateService
> {
  const { agent, conversationId, conversationHistory } = context;

  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    switch (command.type) {
      case "rename":
        return yield* handleRenameCommand(terminal, context, command.args);

      case "create": {
        const created = yield* Effect.either(createAgentCommand());
        if (created._tag === "Left")
          yield* terminal.error(`Failed to create agent: ${created.left.message}`);
        return { shouldContinue: true, skipTranscriptRepaint: true };
      }

      case "start":
        return yield* handleStartCommand(terminal, agent);

      case "fork":
        return yield* handleForkCommand(terminal, conversationHistory);

      case "detach":
        return yield* handleDetachCommand(terminal, context, command.args);

      case "help":
        return yield* handleHelpCommand(terminal, command.args);

      case "limit":
        return yield* handleLimitCommand(terminal, agent, context, command.args);

      case "goal":
        return yield* handleGoalCommand(context, command.args);
      case "loop":
        return yield* handleLoopCommand(context, command.args);

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

      case "reasoning":
        return yield* handleReasoningCommand(terminal, agent, command.args);

      case "model":
        return yield* handleModelCommand(terminal, agent, command.args);

      case "exit":
        return { shouldContinue: false };

      case "config":
        return yield* handleConfigCommand(terminal, agent, command.args);

      case "skills":
        return yield* handleSkillsCommand(terminal);

      case "memory":
        return yield* handleMemoryCommand(terminal, agent, command.args);

      case "context":
        return yield* handleContextCommand(terminal, agent, conversationHistory);

      case "work":
        return yield* handleWorkCommand(terminal, agent, context.conversationId, command.args);

      case "cost":
        return yield* handleCostCommand(terminal, agent, context.sessionUsage);

      case "workflows":
        return yield* handleWorkflowsCommand(terminal, command.args);

      case "info":
        return yield* handleInfoCommand(terminal, agent, context);

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

      case "runPluginCommand":
        return yield* handlePluginCommand(context.agent.id, command.args);

      case "unknown":
        return yield* handleUnknownCommand(terminal, command.args);

      default:
        return { shouldContinue: true };
    }
  });
}

/** Move the current conversation only after a reviewed snapshot receives a remote start receipt. */
function handleDetachCommand(
  terminal: TerminalService,
  context: CommandContext,
  args: readonly string[],
): Effect.Effect<CommandResult, never, FileSystemContextService> {
  return Effect.gen(function* () {
    const hostName = args[0];
    if (hostName === undefined || args.length !== 1) {
      yield* terminal.warn("Usage: /detach <registered-host>. Run jazz hosts list to see hosts.");
      return { shouldContinue: true };
    }
    if (context.queuedAfterCommand) {
      yield* terminal.warn(
        "Messages are queued after /detach. Clear or send them before moving this conversation.",
      );
      return { shouldContinue: true };
    }
    if (!terminal.isInteractive) {
      yield* terminal.error("/detach needs an interactive terminal to review the transfer.");
      return { shouldContinue: true };
    }

    const continuation = yield* terminal.ask("What should Jazz continue doing on the host?", {
      cancellable: true,
      simple: true,
      validate: (value) => value.trim().length > 0 || "Enter a continuation instruction.",
    });
    if (continuation === undefined) {
      yield* terminal.info("Detach cancelled. This conversation remains local.");
      return { shouldContinue: true };
    }

    const fileSystemContext = yield* FileSystemContextServiceTag;
    const cwd = yield* fileSystemContext.getCwd({
      agentId: context.agent.id,
      conversationId: context.conversationId,
    });
    const prepared = yield* Effect.either(
      Effect.tryPromise(() =>
        prepareDetachTransfer({
          agentId: context.agent.id,
          conversationId: context.conversationId,
          history: context.conversationHistory,
          hostName,
          cwd,
          continuation: continuation.trim(),
        }),
      ),
    );
    if (prepared._tag === "Left") {
      yield* terminal.error(`Could not prepare detach: ${String(prepared.left)}`);
      return { shouldContinue: true };
    }

    const preview = prepared.right;
    const shownFiles = preview.manifest.entries.slice(0, DETACH_FILES_SHOWN);
    const hiddenFiles = preview.manifest.entries.length - shownFiles.length;
    yield* terminal.log(
      report("detach", [
        { kind: "field", key: "host", value: preview.hostName },
        {
          kind: "field",
          key: "copies",
          value: `${String(preview.manifest.entries.length)} files, ${String(Math.ceil(preview.bytes / 1024))} KiB`,
          detail: "including this repository's Git HEAD and history",
        },
        {
          kind: "field",
          key: "credentials",
          value: preview.credentialNames.length > 0 ? preview.credentialNames.join(", ") : "none",
        },
        {
          kind: "field",
          key: "limits",
          value:
            `${preview.approvalPolicy} approvals, $${String(preview.maxCostUSD)}, ` +
            `${String(Math.round(preview.maxDurationMs / 3_600_000))}h, ${String(preview.maxIterations)} iterations`,
        },
        { kind: "field", key: "continues with", value: preview.continuation },
        { kind: "gap" },
        ...shownFiles.map((entry): ReportRow => ({ kind: "item", name: entry.relativePath })),
        ...(hiddenFiles > 0
          ? [
              {
                kind: "text",
                text: `and ${String(hiddenFiles)} more files`,
                tone: "muted",
              } as const,
            ]
          : []),
      ]),
    );
    for (const warning of preview.warnings) yield* terminal.warn(warning);
    const approved = yield* terminal.confirm(
      `Copy this state to ${preview.hostName} and continue there?`,
      false,
    );
    if (approved !== true) {
      const canceled = yield* Effect.either(Effect.tryPromise(() => cancelDetachTransfer(preview)));
      if (canceled._tag === "Left") {
        yield* terminal.warn(`Could not remove the staged copy: ${String(canceled.left)}`);
      }
      yield* terminal.info("Detach cancelled. This conversation remains local.");
      return { shouldContinue: true };
    }

    yield* terminal.info("Transferring and starting the remote run…");
    const committed = yield* Effect.either(
      Effect.tryPromise({
        try: () => commitDetachTransfer(preview),
        catch: (error) => error,
      }),
    );
    if (committed._tag === "Left") {
      yield* terminal.error(`Detach did not complete: ${String(committed.left)}`);
      if (committed.left instanceof DetachCommitError && committed.left.localMayContinue) {
        yield* terminal.info(
          "The transfer stopped before remote ownership. This conversation is still local.",
        );
        return { shouldContinue: true };
      }
      yield* terminal.warn(
        `Check jazz detach status ${preview.handoffId} before retrying; remote ownership may be uncertain.`,
      );
      return { shouldContinue: false };
    }
    const receipt = committed.right;
    yield* terminal.log(
      report(
        "detach",
        [
          { kind: "field", key: "remote run", value: `${receipt.state} on ${receipt.hostName}` },
          {
            kind: "field",
            key: "watch and reply",
            value: `jazz detach attach ${receipt.handoffId}`,
          },
          {
            kind: "field",
            key: "bring it back",
            value: `jazz detach reclaim ${receipt.handoffId}`,
          },
        ],
        "You can close this terminal; the remote host owns the conversation now.",
      ),
    );
    return { shouldContinue: false };
  });
}

/** How many of the files a detach copies its preview names before summarising the rest. */
const DETACH_FILES_SHOWN = 12;

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

    const outputForAgent = redactSecretText(combinedOutput, yield* toolKnownSecrets());
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
        outputForAgent ? `Command output:\n${outputForAgent}` : "Command output: (none)",
        "",
        "Use this command result as context for your response. Do not claim to have run the command yourself.",
      ].join("\n"),
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
 * One row per theme for /theme: the name to type, then its label, the variants it has, and
 * where a user theme came from. The theme on screen is marked current.
 */
export function themeListingRows(listings: readonly ThemeListing[]): ReportRow[] {
  const byName = new Map<string, ThemeListing[]>();
  for (const listing of listings) {
    byName.set(listing.name, [...(byName.get(listing.name) ?? []), listing]);
  }
  const rows: ReportRow[] = [];
  for (const [name, variants] of byName) {
    const first = variants[0] as ThemeListing;
    const current = variants.find((listing) => listing.current);
    const detail = [
      first.label,
      first.source === "system"
        ? "your terminal's own colours"
        : variants.map((listing) => listing.variant).join(", "),
      ...(first.source === "builtin" || first.source === "system" ? [] : [first.source]),
      ...(current === undefined ? [] : [`showing ${current.variant}`]),
    ].join(" · ");
    rows.push(
      current === undefined
        ? { kind: "item", name, detail }
        : { kind: "item", name, detail, marker: "current" },
    );
  }
  return rows;
}

/** Commit a theme choice and save it, reporting what is now on screen. */
export function commitTheme(
  terminal: TerminalService,
  requested: string,
): Effect.Effect<boolean, never, AgentConfigService> {
  return Effect.gen(function* () {
    const result = applyTheme(requested);
    if (!result.ok) {
      yield* terminal.warn(`${result.error}.`);
      return false;
    }
    const configService = yield* AgentConfigServiceTag;
    yield* configService.set("ui.theme", result.setting);
    const override = process.env["JAZZ_THEME"];
    yield* terminal.log(
      report(
        "theme",
        [
          { kind: "field", key: "now", value: `${result.label}, ${result.variant}` },
          { kind: "field", key: "saved as", value: `ui.theme ${result.setting}` },
        ],
        override === undefined
          ? undefined
          : `JAZZ_THEME=${override} is set and wins at the next start.`,
      ),
    );
    return true;
  });
}

/**
 * Handle /theme. With a name it switches and saves. Without one, the fullscreen interface
 * opens a picker that previews each theme across the whole window; every other surface
 * lists the themes.
 */
function handleThemeCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, AgentConfigService> {
  return Effect.gen(function* () {
    const requested = args.join(" ").trim();
    if (requested !== "") {
      yield* commitTheme(terminal, requested);
      return { shouldContinue: true };
    }

    if (terminal.isInteractive && activeKeymapMode() === "fullscreen") {
      const chosen = yield* Effect.promise(() => pickThemeInteractively());
      if (chosen !== undefined) {
        yield* commitTheme(terminal, chosen);
      }
      return { shouldContinue: true };
    }

    const directory = getUserThemesDirectory();
    const warnings = themeWarnings().map((warning): ReportRow => ({
      kind: "text",
      text: warning,
      tone: "warning",
    }));
    yield* terminal.log(
      report(
        "theme",
        [
          ...themeListingRows(listThemes()),
          ...(warnings.length > 0 ? [{ kind: "gap" } as const, ...warnings] : []),
        ],
        `/theme <name> [dark|light] switches and saves.${directory === null ? "" : ` Your own go in ${directory}.`}`,
      ),
    );
    return { shouldContinue: true };
  });
}

/** Longest command form /help shows in full; `/help <command>` has every form. */
const HELP_LABEL_MAX = 32;

function helpItem(label: string, description: string): ReportRow {
  return { kind: "item", name: truncate(label, HELP_LABEL_MAX), detail: description };
}

/**
 * Handle /help. The command list comes from CHAT_COMMANDS and the registered
 * skill, MCP prompt and plugin commands (the same lists autocomplete and the
 * parser use), and the keys from the keymap of the interface that is running.
 * `/help <command>` shows every form of one command.
 */
function handleHelpCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    const requested = args[0]?.toLowerCase().replace(/^\//, "");
    if (requested !== undefined) {
      const command = findCommand(requested);
      if (command === undefined) {
        const suggestion = suggestCommand(requested);
        yield* terminal.warn(
          suggestion === undefined
            ? `Unknown command "/${requested}". Run /help for the full list.`
            : `Unknown command "/${requested}". Did you mean /${suggestion.name}?`,
        );
        return { shouldContinue: true };
      }
      const builtin = findBuiltinCommand(command.name);
      const usage = builtin === undefined ? undefined : commandUsage(builtin);
      yield* terminal.log(
        report(
          `/${command.name}`,
          [
            { kind: "field", key: "usage", value: commandSignature(command) },
            { kind: "field", key: "does", value: command.description },
            ...(command.aliases !== undefined && command.aliases.length > 0
              ? [
                  {
                    kind: "field",
                    key: "also",
                    value: command.aliases.map((alias) => `/${alias}`).join(", "),
                  } as const,
                ]
              : []),
            ...(command.source === undefined
              ? []
              : [
                  {
                    kind: "field",
                    key: "from",
                    value: COMMAND_SOURCE_LABEL[command.source],
                  } as const,
                ]),
            ...(usage === undefined || usage.rows.length === 0
              ? []
              : [{ kind: "gap" } as const, ...usage.rows]),
          ],
          usage?.note,
        ),
      );
      return { shouldContinue: true };
    }

    const registered = registeredCommands();
    const sections: readonly (readonly [string, readonly ChatCommandInfo[]])[] = [
      ["skills", registered.skills],
      ["mcp prompts", registered.mcpPrompts],
      ["plugin commands", registered.plugins],
    ];
    const rows: ReportRow[] = [
      { kind: "group", label: "commands" },
      ...CHAT_COMMANDS.map((command) => helpItem(commandSignature(command), command.description)),
      helpItem(SHELL_ESCAPE_FORM, "Run a shell command and give its output to the agent"),
    ];
    for (const [title, entries] of sections) {
      if (entries.length === 0) {
        continue;
      }
      rows.push(
        { kind: "gap" },
        { kind: "group", label: title },
        ...entries.map((command) => helpItem(commandSignature(command), command.description)),
      );
    }
    rows.push(
      { kind: "gap" },
      { kind: "group", label: "keys" },
      ...KEYMAPS[activeKeymapMode()].map((binding) =>
        helpItem(bindingLabel(binding), binding.action),
      ),
    );
    yield* terminal.log(report("help", rows, "Run /help <command> for every form of one command."));
    return { shouldContinue: true };
  });
}

/** How /help names where a registered command comes from. */
const COMMAND_SOURCE_LABEL: Readonly<Record<NonNullable<ChatCommandInfo["source"]>, string>> = {
  skill: "a skill",
  "mcp-prompt": "an MCP server prompt",
  plugin: "a plugin",
};

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

    const sortedCategories = Object.keys(filteredToolsByCategory).sort();
    if (sortedCategories.length === 0) {
      yield* terminal.log(report("tools", [{ kind: "text", text: `${agent.name} has no tools.` }]));
      return { shouldContinue: true };
    }
    const rows: ReportRow[] = [];
    let totalTools = 0;
    for (const category of sortedCategories) {
      const tools = filteredToolsByCategory[category] ?? [];
      totalTools += tools.length;
      if (rows.length > 0) {
        rows.push({ kind: "gap" });
      }
      rows.push({ kind: "group", label: category, count: String(tools.length) });
      for (const tool of tools) {
        rows.push(
          tool === "web_search" && webSearchProvider
            ? { kind: "item", name: tool, detail: webSearchProvider }
            : { kind: "item", name: tool },
        );
      }
    }
    yield* terminal.log(
      report(
        "tools",
        rows,
        `${agent.name} has ${String(totalTools)} tools in ${String(sortedCategories.length)} groups.`,
      ),
    );
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
    const supportsNative = yield* llmService.supportsNativeWebSearch(agent.config.llm.provider);
    if (supportsNative) {
      const providerName =
        agent.config.llm.provider.charAt(0).toUpperCase() + agent.config.llm.provider.slice(1);
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

    if (allAgentsUnsorted.length === 0) {
      yield* terminal.log(
        report(
          "agents",
          [{ kind: "text", text: "No agents yet." }],
          "Create one with jazz agent create.",
        ),
      );
      return { shouldContinue: true };
    }
    const allAgents = sortAgents(allAgentsUnsorted, lastUsedAgentId);
    const rows: ReportRow[] = allAgents.map((listed) => {
      const reasoning =
        listed.config.llm.reasoning === undefined
          ? ""
          : ` · reasoning ${reasoningSelectionToCliValue(listed.config.llm.reasoning)}`;
      const detail = `${listed.config.llm.provider}/${listed.config.llm.model} · ${listed.config.persona}${reasoning}`;
      return listed.id === currentAgent.id
        ? { kind: "item", name: listed.name, detail, marker: "current" }
        : { kind: "item", name: listed.name, detail };
    });
    yield* terminal.log(
      report(
        "agents",
        rows,
        `${String(allAgents.length)} agent${allAgents.length === 1 ? "" : "s"}. Switch with /switch <name>.`,
      ),
    );
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

    if (peers.length === 0) {
      yield* terminal.log(
        report(
          "peers",
          [{ kind: "text", text: "No peers yet." }],
          "Add one with an invite: jazz peers invite create, then accept.",
        ),
      );
      return { shouldContinue: true };
    }
    const rows: ReportRow[] = [];
    for (const peer of peers) {
      if (rows.length > 0) {
        rows.push({ kind: "gap" });
      }
      rows.push(
        { kind: "group", label: peer.name },
        {
          kind: "field",
          key: "endpoint",
          value: peer.url ?? "none, so it cannot be asked",
          ...(peer.url === undefined ? { tone: "muted" as const } : {}),
        },
        { kind: "field", key: "may learn", value: describeTier(peer.disclosure) },
        { kind: "field", key: "answers as", value: peer.persona ?? "the agent's default persona" },
        {
          kind: "field",
          key: "also allowed",
          value:
            peer.allow !== undefined && peer.allow.length > 0
              ? peer.allow.join(", ")
              : "nothing beyond reading",
        },
      );
    }
    yield* terminal.log(
      report("peers", rows, `${String(peers.length)} peer${peers.length === 1 ? "" : "s"}.`),
    );
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
              yield* terminal.error(`Error loading agent: ${toError(error).message}`);
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
          `Switched to ${newAgent.name} (${newAgent.config.llm.provider}/${newAgent.config.llm.model})`,
        );

        // Check if model supports tools and warn if not
        const modelMeta = yield* Effect.promise(() =>
          getModelsDevMetadata(newAgent.config.llm.model, newAgent.config.llm.provider),
        );
        if (
          modelMeta &&
          !modelMeta.supportsTools &&
          newAgent.config.tools &&
          newAgent.config.tools.length > 0
        ) {
          yield* terminal.log("");
          yield* terminal.warn(
            `${newAgent.config.llm.model} does not support tools, so this agent's tools are off for this model.`,
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
      name: `${ag.name} - ${ag.config.llm.provider}/${ag.config.llm.model} · ${ag.config.persona}${ag.id === currentAgent.id ? " (current)" : ""}`,
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
      `Switched to ${newAgent.name} (${newAgent.config.llm.provider}/${newAgent.config.llm.model})`,
    );

    // Check if model supports tools and warn if not
    const modelMeta = yield* Effect.promise(() =>
      getModelsDevMetadata(newAgent.config.llm.model, newAgent.config.llm.provider),
    );
    if (
      modelMeta &&
      !modelMeta.supportsTools &&
      newAgent.config.tools &&
      newAgent.config.tools.length > 0
    ) {
      yield* terminal.log("");
      yield* terminal.warn(
        `${newAgent.config.llm.model} does not support tools, so this agent's tools are off for this model.`,
      );
    }

    yield* terminal.log("");

    return { shouldContinue: true, newAgent };
  });
}

/** Human-readable size for a tool result, so a decision line reads "Bash · 8.2k chars". */
function formatCharCount(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

/**
 * Render one compaction phase as lines for the live region: the plugin's per-result
 * keep/truncate/drop calls with a rollup, then the summarizer step.
 */
function compactionPhaseLines(event: CompactionProgress): string[] {
  switch (event.phase) {
    case "prune-start":
      return [
        event.plugin === undefined
          ? "Reviewing tool results…"
          : `Reviewing tool results with the ${event.plugin} plugin…`,
      ];
    case "prune-done": {
      if (event.decisions.length === 0) return ["No stale tool results to prune."];
      const counts: Record<string, number> = { keep: 0, truncate: 0, drop: 0 };
      const detail: string[] = [];
      for (const decision of event.decisions) {
        counts[decision.action] = (counts[decision.action] ?? 0) + 1;
        detail.push(
          `  ${decision.action.padEnd(8)} ${decision.tool} · ${formatCharCount(decision.chars)}`,
        );
      }
      const summary =
        `${counts["drop"]} dropped · ${counts["truncate"]} truncated · ${counts["keep"]} kept` +
        ` · ~${event.tokensReclaimed.toLocaleString()} tokens reclaimed`;
      return [...detail, summary];
    }
    case "summarize-start":
      return [`Summarizing ${event.messageCount} older messages…`];
  }
}

/**
 * Handle /compact command - compact history now, exactly as automatic compaction would.
 *
 * This used to summarize every message into one and replace the history with
 * [system, summary]: nothing recent was kept, a pinned task message and any earlier
 * summary were flattened into it, and no journal entry was written. It now takes the
 * shared compaction path, so it only ever differs from auto-compaction in when it runs.
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

    // The same window a run compacts against, so the recent messages kept verbatim are
    // the same share of it.
    const provider = agent.config.llm.provider;
    const localConfig =
      provider === "llamacpp" || provider === "vllm" || provider === "sglang"
        ? (yield* (yield* AgentConfigServiceTag).appConfig).llm
        : undefined;
    const servedVllm =
      provider === "vllm"
        ? yield* resolveVllmServerModel(agent.config.llm.model, localConfig)
        : undefined;
    const servedSglang =
      provider === "sglang"
        ? yield* resolveSglangServerModel(agent.config.llm.model, localConfig)
        : undefined;
    const advertisedContextWindow = yield* getModelContextWindowEffect(
      servedVllm?.modelId ?? servedSglang?.modelId ?? agent.config.llm.model,
      provider,
    );
    const servedContextWindow =
      provider === "llamacpp"
        ? (yield* resolveLlamaCppServerModel(localConfig)).contextWindow
        : (servedVllm?.contextWindow ?? servedSglang?.contextWindow);
    const contextWindow = resolveEffectiveContextWindow({
      provider,
      ...(advertisedContextWindow !== undefined && { modelMaxTokens: advertisedContextWindow }),
      ...(typeof agent.config.llm.numCtx === "number" && {
        pinnedContextWindow: agent.config.llm.numCtx,
      }),
      ...(typeof servedContextWindow === "number" && { serverContextWindow: servedContextWindow }),
      ...(typeof agent.config.llm.maxContextTokens === "number" && {
        agentMaxTokens: agent.config.llm.maxContextTokens,
      }),
    }).tokens;

    // A live region shows the work as it happens: the plugin's keep/truncate/drop calls,
    // then the summarizer. Its header ticks a running clock, so a slow summary reads as
    // in-progress rather than frozen.
    const presentationService = yield* PresentationServiceTag;
    const startedAt = Date.now();
    const regionId = yield* presentationService.openEphemeralRegion(
      "subagent",
      `Compacting ${conversationHistory.length - 1} messages`,
    );
    let firstAppend = true;
    const onPhase: CompactionProgressObserver = (event) =>
      Effect.suspend(() => {
        const lines = compactionPhaseLines(event);
        if (lines.length === 0) return Effect.void;
        const text = (firstAppend ? "" : "\n") + lines.join("\n");
        firstAppend = false;
        return presentationService.appendEphemeralRegion(regionId, text);
      });

    let compactionFailed = false;
    const outcome = yield* AgentRunner.compactHistory(
      conversationHistory as unknown as ConversationMessages,
      agent,
      conversationId,
      contextWindow,
      onPhase,
    ).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          compactionFailed = true;
          yield* terminal.error(`Failed to compact history: ${error.message}`);
          return null;
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() =>
          presentationService.collapseEphemeralRegion(regionId, "Compaction", {
            status: compactionFailed ? "failed" : "completed",
            durationMs: Date.now() - startedAt,
          }),
        ),
      ),
    );

    if (outcome === null) {
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    if (outcome === undefined) {
      yield* terminal.info(
        "Nothing to compact yet: the whole conversation still counts as recent.",
      );
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const tokensSaved = outcome.tokensBefore - outcome.tokensAfter;
    yield* terminal.success(
      `Compacted ${conversationHistory.length} → ${outcome.messages.length} messages (saved ~${tokensSaved.toLocaleString()} tokens)`,
    );
    yield* terminal.log("   The agent's context is summarized; your on-screen history stays.");
    yield* terminal.log("");

    return { shouldContinue: true, newHistory: [...outcome.messages], skipTranscriptRepaint: true };
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
      catch: toError,
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
 * Handle /reasoning command - Change structured reasoning selection for this session only.
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
): Effect.Effect<CommandResult, never, LLMService> {
  const applyValue = (value: CliReasoningValue): CommandResult => {
    // Session-only: override the in-memory agent config without persisting it.
    const newAgent = {
      ...agent,
      config: {
        ...agent.config,
        llm: { ...agent.config.llm, reasoning: reasoningSelectionFromCliValue(value) },
      },
    };
    return { shouldContinue: true, newAgent };
  };

  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const control = yield* llmService.resolveReasoningControl(
      agent.config.llm.provider,
      agent.config.llm.model,
    );
    const modelLabel = `${agent.config.llm.provider}/${agent.config.llm.model}`;
    const supported = reasoningChoicesFor(control, agent.config.llm.reasoning);

    if (args.length > 0) {
      const value = args[0] ?? "";
      if (args.length !== 1 || !isCliReasoningValue(value)) {
        yield* terminal.error(`Invalid reasoning level. Use: ${supported.join(", ")}`);
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      const adjustment = describeReasoningAdjustment(value, control);
      const effective = reasoningSelectionToCliValue(clampReasoningSelection(value, control));
      if (adjustment) {
        yield* terminal.warn(`${modelLabel}: ${adjustment}.`);
      } else if (control.kind === "unsupported" && value !== "disable") {
        yield* terminal.warn(`${modelLabel} does not reason, so this level has no effect.`);
      }
      yield* terminal.success(`Reasoning set to: ${effective} (this session only)`);
      yield* terminal.log("");
      return applyValue(effective);
    }

    if (control.kind === "unsupported") {
      yield* terminal.info(`${modelLabel} does not reason, so there is no level to set.`);
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    if (terminal.isInteractive) {
      const selected = yield* Effect.promise(() =>
        promptForReasoningSelection(terminal, agent.config.llm.reasoning, {
          prompt: "Set reasoning effort for this session:",
          control,
        }),
      );
      if (!selected) {
        yield* terminal.log("");
        return { shouldContinue: true };
      }
      const value = reasoningSelectionToCliValue(selected);
      yield* terminal.log(
        report("reasoning", [{ kind: "field", key: "now", value }], "For this session only."),
      );
      return applyValue(value);
    }

    const adjustment = describeReasoningAdjustment(agent.config.llm.reasoning, control);
    const current = reasoningSelectionToCliValue(agent.config.llm.reasoning);
    yield* terminal.log(
      report(
        "reasoning",
        [
          {
            kind: "field",
            key: "now",
            value: current,
            ...(adjustment ? { detail: adjustment } : {}),
          },
          { kind: "field", key: "levels", value: supported.join(", ") },
        ],
        control.kind === "unknown"
          ? `Jazz cannot confirm which of these ${modelLabel} accepts.`
          : "Change it with /reasoning <level>, for this session only.",
      ),
    );
    return { shouldContinue: true };
  });
}

/**
 * Handle /model: change the agent's model for this session only, on the
 * agent's own provider. `/model <id>` sets it directly; bare `/model` opens a
 * picker, or prints the current model and a few others on a terminal that
 * cannot prompt. The agent file keeps its model (`jazz agent edit` changes that).
 */
function handleModelCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  args: string[],
): Effect.Effect<CommandResult, never, LLMService> {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const provider = agent.config.llm.provider;
    const current = `${provider}/${agent.config.llm.model}`;
    const providerInfo = yield* llmService.getProvider(provider).pipe(Effect.either);
    const models = providerInfo._tag === "Right" ? providerInfo.right.supportedModels : [];

    const applyModel = (modelId: string) =>
      Effect.gen(function* () {
        if (modelId === agent.config.llm.model) {
          yield* terminal.info(`Already using ${current}.`);
          yield* terminal.log("");
          return { shouldContinue: true } satisfies CommandResult;
        }
        const newAgent = {
          ...agent,
          config: { ...agent.config, llm: { ...agent.config.llm, model: modelId } },
        };
        yield* terminal.log(
          report(
            "model",
            [{ kind: "field", key: "now", value: `${provider}/${modelId}` }],
            "For this session only. jazz agent edit changes the agent's model.",
          ),
        );
        const modelMeta = yield* Effect.promise(() => getModelsDevMetadata(modelId, provider));
        if (modelMeta && !modelMeta.supportsTools && (agent.config.tools?.length ?? 0) > 0) {
          yield* terminal.warn(
            `${modelId} does not support tools, so this agent's tools are unavailable until you switch back.`,
          );
        }
        yield* terminal.log("");
        return { shouldContinue: true, newAgent } satisfies CommandResult;
      });

    const requested = args.join(" ").trim();
    if (requested.length > 0) {
      const modelId = requested.startsWith(`${provider}/`)
        ? requested.slice(provider.length + 1)
        : requested;
      if (models.length > 0 && !models.some((model) => model.id === modelId)) {
        const suggestion = closestMatch(
          modelId,
          models.map((model) => model.id),
        );
        yield* terminal.error(
          suggestion === undefined
            ? `${provider} has no model "${modelId}". Run /model to pick one.`
            : `${provider} has no model "${modelId}". Did you mean ${suggestion}?`,
        );
        yield* terminal.log("");
        return { shouldContinue: true, keepDraft: true };
      }
      return yield* applyModel(modelId);
    }

    if (models.length === 0) {
      yield* terminal.log(
        report(
          "model",
          [{ kind: "field", key: "now", value: current }],
          `Jazz could not list ${provider}'s models. Use /model <model-id>.`,
        ),
      );
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    if (!terminal.isInteractive) {
      yield* terminal.log(
        report(
          "model",
          [{ kind: "field", key: "now", value: current }],
          `Use /model <model-id>, for example /model ${models[0]?.id ?? ""}.`,
        ),
      );
      yield* terminal.log("");
      return { shouldContinue: true };
    }

    const selected = yield* terminal.search<string>(
      `Model for this session (now ${agent.config.llm.model}):`,
      {
        choices: buildModelChoices(provider, models),
        placeholder: "Type to filter models…",
      },
    );
    if (selected === undefined) {
      yield* terminal.log("");
      return { shouldContinue: true };
    }
    return yield* applyModel(selected);
  });
}

/**
 * Handle /limit command - view or set a session-wide turn/cost/token cap.
 *
 * "Session-wide" means the limit stays in effect for the rest of this
 * conversation (not just the current turn) and is checked before every turn
 * against this conversation's accumulated usage — the same numbers /cost and
 * /info show. With no args in an interactive terminal this opens the picker
 * (select the metric, then type a value); with no args elsewhere it prints
 * current usage and limits. A limit that's already exceeded the moment it's
 * set is reported immediately here — enforcement itself happens on the next
 * turn attempt in the chat loop.
 */
function handleLimitCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  context: CommandContext,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  const metricAliases: Record<string, SessionLimitMetric> = {
    turn: "turns",
    turns: "turns",
    usd: "usd",
    cost: "usd",
    dollar: "usd",
    dollars: "usd",
    token: "tokens",
    tokens: "tokens",
  };

  const parseValue = (raw: string): number | null | "invalid" => {
    const lower = raw.toLowerCase();
    if (lower === "clear" || lower === "none" || lower === "off") return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
    return parsed;
  };

  const currentUsage = Effect.gen(function* () {
    const costUSD = yield* estimateSessionCostUSD(context.sessionUsage, agent);
    return {
      turns: context.sessionTurnCount,
      costUSD,
      tokens: context.sessionUsage.promptTokens + context.sessionUsage.completionTokens,
    };
  });

  const applyLimit = (
    metric: SessionLimitMetric,
    value: number | null,
  ): Effect.Effect<CommandResult, never, never> =>
    Effect.gen(function* () {
      const field = SESSION_LIMIT_FIELD[metric];
      const nextLimits: SessionLimits = { ...context.sessionLimits };
      if (value === null) {
        delete nextLimits[field];
      } else {
        nextLimits[field] = value;
      }
      yield* terminal.log(
        report(
          "limit",
          [
            {
              kind: "field",
              key: metric,
              value: value === null ? "no limit" : formatSessionLimitMetric(metric, value),
            },
          ],
          "For this session only.",
        ),
      );
      yield* terminal.log(fmt.blank());

      if (value !== null) {
        const usage = yield* currentUsage;
        const exceeded = findExceededSessionLimits(nextLimits, usage);
        if (exceeded.length > 0) {
          yield* confirmSessionLimitOverage(terminal, exceeded);
          yield* terminal.log(fmt.blank());
        }
      }

      return { shouldContinue: true, newSessionLimits: nextLimits };
    });

  return Effect.gen(function* () {
    if (args.length === 1 && args[0]?.toLowerCase() === "clear") {
      yield* terminal.log(report("limit", [{ kind: "text", text: "No session limits." }]));
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true, newSessionLimits: {} };
    }

    if (args.length > 0) {
      const metric = metricAliases[(args[0] ?? "").toLowerCase()];
      if (!metric) {
        yield* terminal.error(`Unknown limit "${args[0]}". Use: turns, usd, tokens, or clear.`);
        yield* terminal.log(fmt.blank());
        return { shouldContinue: true };
      }
      const rawValue = args[1];
      if (rawValue === undefined) {
        yield* terminal.error(`Usage: /limit ${metric} <value>|clear`);
        yield* terminal.log(fmt.blank());
        return { shouldContinue: true };
      }
      const value = parseValue(rawValue);
      if (value === "invalid") {
        yield* terminal.error(
          `Invalid value "${rawValue}" — expected a positive number or "clear".`,
        );
        yield* terminal.log(fmt.blank());
        return { shouldContinue: true };
      }
      return yield* applyLimit(metric, value);
    }

    // No args: show current usage and limits.
    const usage = yield* currentUsage;
    const limitRows: ReportRow[] = (["turns", "usd", "tokens"] as const).map((metric) => {
      const limitValue = context.sessionLimits[SESSION_LIMIT_FIELD[metric]];
      const used =
        metric === "turns" ? usage.turns : metric === "usd" ? usage.costUSD : usage.tokens;
      return {
        kind: "field",
        key: metric,
        value: formatSessionLimitMetric(metric, used),
        detail:
          limitValue === undefined
            ? "no limit"
            : `of ${formatSessionLimitMetric(metric, limitValue)}`,
      };
    });
    yield* terminal.log(
      report(
        "limit",
        limitRows,
        terminal.isInteractive
          ? undefined
          : "Set one with /limit turns|usd|tokens <value>, or remove them with /limit clear.",
      ),
    );

    if (!terminal.isInteractive) {
      return { shouldContinue: true };
    }

    const selectedMetric = yield* terminal.select<SessionLimitMetric>("Set a session limit:", {
      choices: (["turns", "usd", "tokens"] as const).map((metric) => ({
        name: metric,
        value: metric,
      })),
    });
    if (!selectedMetric) {
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }

    const currentValue = context.sessionLimits[SESSION_LIMIT_FIELD[selectedMetric]];
    const rawValue = yield* terminal.ask(
      `New ${selectedMetric} limit (number, or "clear" to remove it):`,
      {
        cancellable: true,
        simple: true,
        ...(currentValue !== undefined ? { defaultValue: String(currentValue) } : {}),
        validate: (input) => {
          const parsed = parseValue(input);
          return parsed === "invalid" ? 'Enter a positive number, or "clear".' : true;
        },
      },
    );
    if (rawValue === undefined) {
      yield* terminal.log(fmt.blank());
      return { shouldContinue: true };
    }
    const value = parseValue(rawValue);
    if (value === "invalid") {
      return { shouldContinue: true };
    }
    return yield* applyLimit(selectedMetric, value);
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

      if (selected === undefined) {
        return { shouldContinue: true };
      }

      const newTools = [...selected];

      // Report changes
      const added = newTools.filter((t) => !agentToolSet.has(t));
      const removed = agentToolNames.filter((t) => !newTools.includes(t));
      if (added.length === 0 && removed.length === 0) {
        yield* terminal.log(report("config", [{ kind: "text", text: "No changes." }]));
        return { shouldContinue: true };
      }
      yield* terminal.log(
        report("config", [
          ...added.map((tool): ReportRow => ({
            kind: "item",
            name: tool,
            detail: "on",
            marker: "active",
          })),
          ...removed.map((tool): ReportRow => ({
            kind: "item",
            name: tool,
            detail: "off",
            marker: "disabled",
          })),
        ]),
      );

      const updatedConfig = { ...agent.config, tools: newTools };
      const newAgent = yield* agentService.updateAgent(agent.id, { config: updatedConfig });
      yield* terminal.log("");
      return { shouldContinue: true, newAgent };
    }

    // No args: show full config
    const agentToolNames = normalizeToolConfig(agent.config.tools, { agentId: agent.id });
    const shownTools = agentToolNames.slice(0, CONFIG_TOOLS_SHOWN);
    const hiddenTools = agentToolNames.length - shownTools.length;
    yield* terminal.log(
      report(
        "config",
        [
          { kind: "field", key: "name", value: agent.name },
          ...(agent.description
            ? [{ kind: "field", key: "about", value: agent.description } as const]
            : []),
          { kind: "field", key: "persona", value: agent.config.persona },
          {
            kind: "field",
            key: "model",
            value: `${agent.config.llm.provider}/${agent.config.llm.model}`,
          },
          {
            kind: "field",
            key: "reasoning",
            value: reasoningSelectionToCliValue(agent.config.llm.reasoning),
          },
          { kind: "field", key: "tools", value: `${String(agentToolNames.length)} on` },
          ...(shownTools.length === 0
            ? []
            : [
                { kind: "gap" } as const,
                ...shownTools.map((tool): ReportRow => ({ kind: "item", name: tool })),
                ...(hiddenTools > 0
                  ? [
                      {
                        kind: "text",
                        text: `and ${String(hiddenTools)} more`,
                        tone: "muted",
                      } as const,
                    ]
                  : []),
              ]),
        ],
        "Turn tools on or off with /config tools.",
      ),
    );
    return { shouldContinue: true };
  });
}

/** How many of an agent's tools /config names before summarising the rest. */
const CONFIG_TOOLS_SHOWN = 10;

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
    yield* terminal.log(sessionOpenLine(agent));
    return { shouldContinue: true };
  });
}

/**
 * Handle /workflows command - List available workflows or create one
 */
function handleWorkflowsCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, Error, WorkflowService> {
  return Effect.gen(function* () {
    if (args[0] === "create") {
      const trailing = args.slice(1).join(" ").trim();
      const prompt =
        trailing.length > 0
          ? `The user wants to create a workflow: ${trailing}. Use the create-workflow skill to guide them.`
          : "The user wants to create a new workflow. Use the create-workflow skill to guide them through the process.";
      return { shouldContinue: true, messageForAgent: prompt };
    }

    const workflowService = yield* WorkflowServiceTag;

    const workflows = yield* workflowService.listWorkflows();

    if (workflows.length === 0) {
      yield* terminal.log(
        report(
          "workflows",
          [
            { kind: "text", text: "No workflows yet. Add a WORKFLOW.md to either folder:" },
            { kind: "item", name: "./workflows/<name>/WORKFLOW.md", detail: "this folder" },
            { kind: "item", name: "~/.jazz/workflows/<name>/WORKFLOW.md", detail: "everywhere" },
          ],
          "Or run /workflows create and the agent will walk you through it.",
        ),
      );
      return { shouldContinue: true };
    }

    const { local, global } = groupWorkflows(workflows);
    const rows: ReportRow[] = [];
    for (const [label, group] of [
      ["this folder", local],
      ["everywhere", global],
    ] as const) {
      if (group.length === 0) {
        continue;
      }
      if (rows.length > 0) {
        rows.push({ kind: "gap" });
      }
      rows.push(
        { kind: "group", label, count: String(group.length) },
        ...group.map((workflow): ReportRow => ({
          kind: "item",
          name: workflow.name,
          detail: formatWorkflowDesc(workflow),
        })),
      );
    }
    yield* terminal.log(
      report(
        "workflows",
        rows,
        `${String(workflows.length)} workflow${workflows.length === 1 ? "" : "s"}.`,
      ),
    );
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
/**
 * Run a plugin-contributed slash command. `args[0]` is the command name (mirrors the runSkill
 * convention); the rest are its arguments. The plugin's message, if any, becomes the user's next
 * turn. Fail-open: no plugin runtime, or any failure, yields a quiet no-op continuation.
 */
function handlePluginCommand(
  agentId: string,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    const name = args[0] ?? "";
    const runtimeOption = yield* Effect.serviceOption(PluginRuntimeServiceTag);
    if (Option.isNone(runtimeOption)) return { shouldContinue: true };
    const outcome = yield* runtimeOption.value.runAgentCommand(agentId, name, args.slice(1));
    return outcome.message !== undefined && outcome.message.length > 0
      ? { shouldContinue: true, resendMessage: outcome.message }
      : { shouldContinue: true };
  });
}

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
 * Handle an unknown command: say so, suggest the closest command, and keep the
 * draft so a typo is one edit away instead of a retype.
 */
function handleUnknownCommand(
  terminal: TerminalService,
  args: string[],
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    const typed = args[0] ?? "";
    yield* terminal.error(`Unknown command: /${typed}`);
    const suggestion = typed.length > 0 ? suggestCommand(typed) : undefined;
    yield* terminal.info(
      suggestion === undefined
        ? "Type '/help' to see available commands."
        : `Did you mean /${suggestion.name}? Type '/help' to see available commands.`,
    );
    yield* terminal.log("");
    return { shouldContinue: true, keepDraft: true };
  });
}

/**
 * Handle /skills. Interactive terminals browse a bounded catalog; headless
 * callers retain the complete printable inventory.
 */
function handleSkillsCommand(
  terminal: TerminalService,
): Effect.Effect<CommandResult, Error, SkillService> {
  return Effect.gen(function* () {
    const skillService = yield* SkillServiceTag;
    const { builtin, global, agents, local, plugin } = yield* skillService.listSkillsBySource();

    const totalCount =
      builtin.length + global.length + agents.length + local.length + plugin.length;

    if (terminal.isInteractive) {
      const skills = [...builtin, ...global, ...agents, ...local, ...plugin].sort(
        (a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
      );
      yield* Effect.async<void>((resume) => {
        store.setActiveMenu({ kind: "skills", skills }, () => resume(Effect.void));
      });
      return { shouldContinue: true };
    }

    if (totalCount === 0) {
      yield* terminal.log(
        report("skills", [
          { kind: "text", text: "No skills yet. Add a SKILL.md to any of these folders:" },
          { kind: "item", name: "./skills/<name>/SKILL.md", detail: "this folder" },
          { kind: "item", name: "~/.jazz/skills/<name>/SKILL.md", detail: "everywhere" },
          {
            kind: "item",
            name: "~/.agents/skills/<name>/SKILL.md",
            detail: "shared with other agents",
          },
        ]),
      );
      return { shouldContinue: true };
    }

    const rows: ReportRow[] = [];
    let sourcesCount = 0;
    for (const [label, group] of [
      ["built in", builtin],
      ["everywhere", global],
      ["shared agents", agents],
      ["this folder", local],
      ["plugins", plugin],
    ] as const) {
      if (group.length === 0) {
        continue;
      }
      sourcesCount++;
      if (rows.length > 0) {
        rows.push({ kind: "gap" });
      }
      rows.push(
        { kind: "group", label, count: String(group.length) },
        ...[...group]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((skill): ReportRow => ({
            kind: "item",
            name: skill.name,
            detail: skill.description,
          })),
      );
    }
    yield* terminal.log(
      report(
        "skills",
        rows,
        `${String(totalCount)} ${totalCount === 1 ? "skill" : "skills"} from ${String(sourcesCount)} ${sourcesCount === 1 ? "source" : "sources"}.`,
      ),
    );

    return { shouldContinue: true };
  });
}

/**
 * Handle /info command - Show session identity, usage, and where its logs are
 */
function handleInfoCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  context: CommandContext,
): Effect.Effect<CommandResult, never, FileSystemContextService | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const conversation = yield* loadConversationOrNull(agent.id, context.conversationId);

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

    const personaServiceOption = yield* Effect.serviceOption(PersonaServiceTag);
    const persona = Option.isSome(personaServiceOption)
      ? yield* personaServiceOption.value
          .getPersonaByIdentifier(agent.config.persona)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
      : null;
    const totalTools = agent.config.tools?.length ?? 0;

    const fileSystemContext = yield* FileSystemContextServiceTag;
    const workingDirectory = yield* fileSystemContext.getCwd(
      context.conversationId
        ? { agentId: agent.id, conversationId: context.conversationId }
        : { agentId: agent.id },
    );

    const toolCalls = context.conversationHistory.reduce(
      (count, message) => count + (message.tool_calls?.length ?? 0),
      0,
    );
    const { promptTokens, completionTokens } = context.sessionUsage;
    const meta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llm.model, agent.config.llm.provider),
    );
    const inputCost = (promptTokens / 1_000_000) * (meta?.inputPricePerMillion ?? 0);
    const outputCost = (completionTokens / 1_000_000) * (meta?.outputPricePerMillion ?? 0);
    const logsDir = getLogsDirectory();

    yield* terminal.log(
      report("info", [
        {
          kind: "field",
          key: "title",
          value: context.conversationTitle ?? conversation?.title ?? "not saved yet",
          ...(context.conversationTitle === undefined && conversation?.title === undefined
            ? { tone: "muted" as const }
            : {}),
        },
        { kind: "field", key: "conversation", value: context.conversationId },
        { kind: "gap" },
        { kind: "field", key: "agent", value: agent.name, detail: agent.id },
        {
          kind: "field",
          key: "persona",
          value: persona?.name ?? agent.config.persona,
          ...(persona?.filePath === undefined ? {} : { detail: persona.filePath }),
        },
        {
          kind: "field",
          key: "model",
          value: `${agent.config.llm.provider}/${agent.config.llm.model}`,
        },
        {
          kind: "field",
          key: "reasoning",
          value: reasoningSelectionToCliValue(agent.config.llm.reasoning),
        },
        { kind: "field", key: "tools", value: `${String(totalTools)} on` },
        { kind: "field", key: "folder", value: abbreviateHomePath(workingDirectory) },
        { kind: "gap" },
        { kind: "field", key: "duration", value: duration },
        { kind: "field", key: "messages", value: String(context.conversationHistory.length) },
        { kind: "field", key: "tool calls", value: String(toolCalls) },
        { kind: "field", key: "tokens in", value: promptTokens.toLocaleString() },
        { kind: "field", key: "tokens out", value: completionTokens.toLocaleString() },
        { kind: "field", key: "cost", value: formatCost(inputCost + outputCost) },
        { kind: "gap" },
        {
          kind: "field",
          key: "session log",
          value: abbreviateHomePath(
            path.join(logsDir, `${conversationLogGroup(agent.id, context.conversationId)}.log`),
          ),
        },
        {
          kind: "field",
          key: "main log",
          value: abbreviateHomePath(path.join(logsDir, "jazz.log")),
        },
      ]),
    );
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
/**
 * Runtime state of one configured MCP server, resolved without connecting.
 *
 * "needs-auth" is a heuristic, not a live check: an HTTP server with no static
 * headers and no stored OAuth tokens will hit the interactive auth flow on its
 * next connection attempt. It may turn out the server does not require auth at
 * all — the label is a hint, not a guarantee, exactly like the "not connected"
 * case, which covers both "never tried yet this session" and "last attempt
 * failed" since Jazz does not track connection failures across turns.
 */
type McpStatusKind = "connected" | "disabled" | "needs-auth" | "idle";

interface McpServerStatus {
  readonly config: MCPServerConfig;
  readonly kind: McpStatusKind;
  /** Whether this is an HTTP server that authenticates via the stored-token OAuth flow. */
  readonly usesOAuth: boolean;
  readonly hasStoredAuth: boolean;
}

function resolveMcpServerStatus(
  mcpManager: MCPServerManager,
  config: MCPServerConfig,
): Effect.Effect<McpServerStatus, never> {
  return Effect.gen(function* () {
    const enabled = config.enabled !== false;
    const connected = enabled ? yield* mcpManager.isConnected(config.name) : false;
    const usesOAuth = isHttpConfig(config) && !config.headers;
    const storedAuth =
      usesOAuth && isHttpConfig(config) ? yield* hasStoredAuth(config.name, config.url) : false;

    const kind: McpStatusKind = !enabled
      ? "disabled"
      : connected
        ? "connected"
        : usesOAuth && !storedAuth
          ? "needs-auth"
          : "idle";

    return { config, kind, usesOAuth, hasStoredAuth: storedAuth };
  });
}

function mcpStatusLabel(kind: McpStatusKind): string {
  switch (kind) {
    case "connected":
      return "connected";
    case "disabled":
      return "disabled";
    case "needs-auth":
      return "needs authentication";
    case "idle":
      return "not connected";
  }
}

/** The report marker for each server state: live, off, waiting on you, or idle. */
function mcpStatusMarker(kind: McpStatusKind): ReportMarker {
  switch (kind) {
    case "connected":
      return "active";
    case "disabled":
      return "disabled";
    case "needs-auth":
      return "attention";
    case "idle":
      return "inactive";
  }
}

/**
 * One server's facts as report fields: state, transport, trust (which decides whether its
 * tools skip approval, so it sits beside the connection state), where it runs, and what it
 * offers once connected.
 */
function mcpServerFields(
  mcpManager: MCPServerManager,
  status: McpServerStatus,
): Effect.Effect<ReportRow[], never, LoggerService> {
  const { config } = status;
  return Effect.gen(function* () {
    const rows: ReportRow[] = [
      {
        kind: "field",
        key: "status",
        value: mcpStatusLabel(status.kind),
        ...(status.kind === "needs-auth" ? { tone: "warning" as const } : {}),
      },
      { kind: "field", key: "transport", value: config.transport ?? "stdio" },
      {
        kind: "field",
        key: "trust",
        value: config.trusted === true ? "trusted" : "asks every call",
      },
    ];
    if (isStdioConfig(config)) {
      rows.push({
        kind: "field",
        key: "command",
        value: `${config.command}${config.args?.length ? ` ${config.args.join(" ")}` : ""}`,
      });
    } else if (isHttpConfig(config)) {
      rows.push({ kind: "field", key: "url", value: config.url });
    }
    if (status.kind === "connected") {
      const tools = yield* mcpManager.getServerTools(config.name).pipe(Effect.either);
      if (tools._tag === "Right") {
        rows.push({ kind: "field", key: "tools", value: String(tools.right.length) });
      }
      const prompts = yield* mcpManager.getServerPrompts(config.name).pipe(Effect.either);
      if (prompts._tag === "Right" && prompts.right.length > 0) {
        rows.push({
          kind: "field",
          key: "prompts",
          value: prompts.right.map((prompt) => `/${config.name}:${prompt.name}`).join(", "),
        });
      }
    }
    return rows;
  });
}

/** Glyph for the same four states, for the interactive picker's plain-text choice labels. */
function mcpStatusGlyph(kind: McpStatusKind): string {
  const glyphs = getGlyphs();
  switch (kind) {
    case "connected":
      return glyphs.active;
    case "disabled":
      return glyphs.laneEnd;
    case "needs-auth":
      return glyphs.warn;
    case "idle":
      return glyphs.pending;
  }
}

function describeMcpTransport(config: MCPServerConfig): string {
  if (isHttpConfig(config)) return `http · ${config.url}`;
  return `stdio · ${config.command}${config.args?.length ? ` ${config.args.join(" ")}` : ""}`;
}

/**
 * Actions available for one server's current state, in menu order.
 *
 * A disabled server offers only Enable — everything else (reconnecting,
 * auth, trust) is moot until it is turned back on.
 */
function mcpServerActions(status: McpServerStatus): readonly { name: string; value: string }[] {
  if (status.kind === "disabled") {
    return [
      { name: "Enable", value: "enable" },
      { name: "Back", value: "back" },
    ];
  }

  const actions: { name: string; value: string }[] = [];
  if (status.kind === "connected") {
    actions.push({ name: "Reconnect", value: "reconnect" });
    actions.push({ name: "Disconnect", value: "disconnect" });
  } else {
    actions.push({ name: "Connect", value: "connect" });
  }
  if (status.kind === "needs-auth") {
    actions.push({ name: "Authenticate", value: "authenticate" });
  }
  if (status.usesOAuth && status.hasStoredAuth) {
    actions.push({ name: "Forget stored credentials", value: "logout" });
  }
  if (status.config.definedIn !== "project") {
    actions.push({
      name: status.config.trusted === true ? "Untrust" : "Trust",
      value: "toggle-trust",
    });
  }
  actions.push({ name: "Disable", value: "disable" });
  actions.push({ name: "Back", value: "back" });
  return actions;
}

/**
 * Run one action against a server and report the outcome. Returns after a
 * single action — the caller loops back to a freshly resolved status so the
 * action menu never goes stale.
 */
function runMcpServerAction(
  terminal: TerminalService,
  mcpManager: MCPServerManager,
  configService: AgentConfigService,
  status: McpServerStatus,
  action: string,
): Effect.Effect<void, never, LoggerService> {
  const { config } = status;
  return Effect.gen(function* () {
    switch (action) {
      case "enable": {
        yield* configService.set(`mcpServers.${config.name}`, { enabled: true });
        yield* terminal.success(`Enabled ${config.name}`);
        return;
      }
      case "disable": {
        yield* mcpManager.disconnectServer(config.name).pipe(Effect.catchAll(() => Effect.void));
        yield* configService.set(`mcpServers.${config.name}`, { enabled: false });
        yield* terminal.success(`Disabled ${config.name}`);
        return;
      }
      case "connect": {
        const result = yield* mcpManager.connectServer(config).pipe(Effect.either);
        if (result._tag === "Left") {
          yield* terminal.error(result.left.reason);
          if (result.left.suggestion) yield* terminal.info(result.left.suggestion);
          return;
        }
        yield* terminal.success(`Connected to ${config.name}`);
        return;
      }
      case "reconnect": {
        yield* mcpManager.disconnectServer(config.name).pipe(Effect.catchAll(() => Effect.void));
        const result = yield* mcpManager.connectServer(config).pipe(Effect.either);
        if (result._tag === "Left") {
          yield* terminal.error(result.left.reason);
          if (result.left.suggestion) yield* terminal.info(result.left.suggestion);
          return;
        }
        yield* terminal.success(`Reconnected to ${config.name}`);
        return;
      }
      case "disconnect": {
        yield* mcpManager.disconnectServer(config.name).pipe(Effect.catchAll(() => Effect.void));
        yield* terminal.success(`Disconnected ${config.name}`);
        return;
      }
      case "authenticate": {
        if (!isHttpConfig(config)) return;
        yield* terminal.info(`Starting authorization for ${config.name}...`);
        const result = yield* authorizeServer(config.name, config.url, (url) => {
          process.stdout.write(`\nIf your browser did not open, visit:\n${url}\n\n`);
        }).pipe(Effect.either);
        if (result._tag === "Left") {
          yield* terminal.error(`Authorization failed: ${result.left.message}`);
          return;
        }
        yield* terminal.success(`Authorized ${config.name}.`);
        return;
      }
      case "logout": {
        if (!isHttpConfig(config)) return;
        yield* clearServerAuth(config.name, config.url);
        yield* terminal.success(`Cleared stored credentials for ${config.name}.`);
        return;
      }
      case "toggle-trust": {
        const nextTrusted = config.trusted !== true;
        yield* configService.set(`mcpServers.${config.name}`, { trusted: nextTrusted });
        yield* terminal.success(`${nextTrusted ? "Trusted" : "Untrusted"} ${config.name}`);
        return;
      }
    }
  });
}

/**
 * Detail view + action menu for one server. Prints its current state, then
 * lets the user act on it. Returns to the caller on "Back" or Escape.
 */
function runMcpServerDetail(
  terminal: TerminalService,
  mcpManager: MCPServerManager,
  configService: AgentConfigService,
  status: McpServerStatus,
): Effect.Effect<void, never, LoggerService> {
  const { config } = status;
  return Effect.gen(function* () {
    yield* terminal.log(report(config.name, yield* mcpServerFields(mcpManager, status)));

    const action = yield* terminal.select<string>(`${config.name} — choose an action`, {
      choices: mcpServerActions(status),
    });

    if (!action || action === "back") return;

    yield* runMcpServerAction(terminal, mcpManager, configService, status, action);
  });
}

/**
 * Interactive `/mcp` overlay: pick a server to see its live status, then an
 * action to run on it. Loops back to a freshly resolved list after every
 * action so reconnects, auth, and enable/disable are visible immediately.
 */
function runMcpOverlay(
  terminal: TerminalService,
  mcpManager: MCPServerManager,
  configService: AgentConfigService,
): Effect.Effect<CommandResult, never, LoggerService | AgentConfigService> {
  return Effect.gen(function* () {
    while (true) {
      const servers = yield* mcpManager.listServers();
      if (servers.length === 0) {
        yield* terminal.log(report("mcp", [{ kind: "text", text: "No MCP servers." }]));
        return { shouldContinue: true };
      }

      const statuses = yield* Effect.all(
        servers.map((server) => resolveMcpServerStatus(mcpManager, server)),
      );

      const selectedName = yield* terminal.select<string>("MCP servers", {
        choices: [
          ...statuses.map((status) => ({
            name: `${mcpStatusGlyph(status.kind)} ${status.config.name} — ${mcpStatusLabel(status.kind)}`,
            value: status.config.name,
            description: describeMcpTransport(status.config),
          })),
          { name: "Done", value: "__done" },
        ],
      });

      if (!selectedName || selectedName === "__done") {
        return { shouldContinue: true };
      }

      const status = statuses.find((s) => s.config.name === selectedName);
      if (!status) continue;

      yield* runMcpServerDetail(terminal, mcpManager, configService, status);
    }
  });
}

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

      const status = yield* resolveMcpServerStatus(mcpManager, target);
      yield* terminal.log(report(target.name, yield* mcpServerFields(mcpManager, status)));
      return { shouldContinue: true };
    }

    if (servers.length === 0) {
      yield* terminal.log(
        report(
          "mcp",
          [{ kind: "text", text: "No MCP servers." }],
          "Add them to ~/.agents/mcp.json.",
        ),
      );
      return { shouldContinue: true };
    }

    if (terminal.isInteractive && subcommand === undefined) {
      const configService = yield* AgentConfigServiceTag;
      return yield* runMcpOverlay(terminal, mcpManager, configService);
    }

    const rows: ReportRow[] = [];
    for (const server of servers) {
      const status = yield* resolveMcpServerStatus(mcpManager, server);
      if (rows.length > 0) {
        rows.push({ kind: "gap" });
      }
      rows.push(
        {
          kind: "item",
          name: server.name,
          marker: mcpStatusMarker(status.kind),
        },
        ...(yield* mcpServerFields(mcpManager, status)),
      );
    }
    yield* terminal.log(
      report("mcp", rows, `${String(servers.length)} server${servers.length === 1 ? "" : "s"}.`),
    );
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

    if (modeArg === "safe" || modeArg === "yolo") {
      return yield* switchChatMode(terminal, modeArg);
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
    const persistedSet = new Set(persistedAutoApprovedCommands ?? []);
    const allowedRows: ReportRow[] = [
      { kind: "field", key: "mode", value: chatModeForPolicy(currentPolicy) },
      ...(autoApprovedCommands?.length
        ? [
            { kind: "gap" } as const,
            { kind: "group", label: "commands that run without asking" } as const,
            ...autoApprovedCommands.map((command): ReportRow => ({
              kind: "item",
              name: command,
              detail: persistedSet.has(command) ? "always" : "this session",
            })),
          ]
        : []),
      ...(autoApprovedTools?.length
        ? [
            { kind: "gap" } as const,
            { kind: "group", label: "tools that run without asking" } as const,
            ...autoApprovedTools.map((tool): ReportRow => ({ kind: "item", name: tool })),
          ]
        : []),
    ];
    yield* terminal.log(
      report(
        "mode",
        allowedRows,
        "/mode allow <command> lets a command prefix run without asking; /mode disallow undoes it.",
      ),
    );
    const current = chatModeForPolicy(currentPolicy);
    const selected = yield* terminal.select<ChatApprovalMode>("Select tool approval mode:", {
      choices: [
        {
          name: `safe: ask before high-risk tool calls${current === "safe" ? " (current)" : ""}`,
          value: "safe",
        },
        {
          name: `yolo: auto-approve all tool calls${current === "yolo" ? " (current)" : ""}`,
          value: "yolo",
        },
      ],
    });

    if (!selected) {
      return { shouldContinue: true };
    }

    return yield* switchChatMode(terminal, selected);
  });
}

function switchChatMode(
  terminal: TerminalService,
  mode: ChatApprovalMode,
): Effect.Effect<CommandResult, never, never> {
  return Effect.gen(function* () {
    yield* terminal.success(
      mode === "yolo"
        ? "Switched to yolo mode: all tool calls auto-approved"
        : "Switched to safe mode: high-risk tool calls require approval",
    );
    yield* terminal.log("");
    return { shouldContinue: true, newAutoApprovePolicy: policyForChatMode(mode) };
  });
}

// ============================================================================
// Context Command Utilities
// ============================================================================

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
 * `/memory` — what this agent has written down about the person talking to it,
 * and a way to remove any of it without leaving the conversation.
 *
 * Lists the real files and prints their real bytes: what is shown here is
 * exactly what reaches the model, never a regenerated summary of it.
 */
function handleMemoryCommand(
  terminal: TerminalService,
  agent: CommandContext["agent"],
  args: string[],
): Effect.Effect<CommandResult, Error, MemoryService | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const memoryService = yield* MemoryServiceTag;
    const configuredScopes = agent.config.memoryScopes;
    const scopes = effectiveMemoryScopes(configuredScopes);

    if (args[0] === "forget") {
      const target = args[1];
      if (target === undefined) {
        yield* terminal.log(
          report("memory", [
            {
              kind: "text",
              text: "Name the file to forget, for example /memory forget personal/notes.md.",
            },
          ]),
        );
        return { shouldContinue: true };
      }
      const outcome = yield* memoryService.delete(scopes, target);
      if (outcome.success) {
        yield* terminal.log(report("memory", [{ kind: "field", key: "forgot", value: target }]));
      } else {
        yield* terminal.warn(outcome.message);
      }
      return { shouldContinue: true };
    }

    if (args[0] !== undefined) {
      const outcome = yield* memoryService.view(scopes, args[0]);
      if (outcome.kind === "file") {
        const provenance = yield* memoryService
          .provenance(scopes, args[0])
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        yield* terminal.log(
          report("memory", [
            { kind: "field", key: "file", value: outcome.displayPath },
            ...(provenance === undefined
              ? []
              : [
                  {
                    kind: "field",
                    key: "updated",
                    value: provenance.updatedAt.slice(0, 10),
                    detail: `${String(provenance.writeCount)} write${provenance.writeCount === 1 ? "" : "s"}`,
                  } as const,
                ]),
          ]),
        );
        // The file's own bytes, exactly as the model reads them, so no report layout.
        yield* terminal.log(outcome.content);
        return { shouldContinue: true };
      }
      yield* terminal.info(outcome.kind === "directory" ? "That is a directory." : outcome.message);
      return { shouldContinue: true };
    }

    const outcome = yield* memoryService.view(scopes, "");
    const files =
      outcome.kind === "directory" ? outcome.entries.filter((entry) => entry.kind === "file") : [];

    if (files.length === 0) {
      yield* terminal.log(
        report("memory", [
          { kind: "text", text: "Nothing saved yet." },
          { kind: "field", key: "scopes", value: scopes.join(", ") },
        ]),
      );
      return { shouldContinue: true };
    }
    yield* terminal.log(
      report(
        "memory",
        files.map((file): ReportRow => ({ kind: "item", name: file.name })),
        "/memory <path> reads one; /memory forget <path> removes it.",
      ),
    );
    return { shouldContinue: true };
  });
}
/** Characters of the latest compaction summary /work shows before cutting it off. */
const WORK_SUMMARY_PREVIEW = 500;

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
      yield* terminal.log(
        report("work", [{ kind: "text", text: "No conversation yet, so no working state." }]),
      );
      return { shouldContinue: true };
    }

    if (args[0] === "clear") {
      const cleared = yield* clearWorkState(agent.id, conversationId);
      yield* terminal.log(
        report("work", [
          {
            kind: "text",
            text: cleared
              ? "Working state discarded."
              : "Nothing to discard for this conversation.",
          },
        ]),
      );
      return { shouldContinue: true };
    }

    const state = yield* readWorkState(agent.id, conversationId);
    const entries = yield* readJournal(agent.id, conversationId);
    const sizeBytes = yield* workStateSizeBytes(agent.id, conversationId);

    const lines = (text: string, tone?: "muted"): ReportRow[] =>
      text
        .split("\n")
        .map((line): ReportRow =>
          tone === undefined ? { kind: "text", text: line } : { kind: "text", text: line, tone },
        );
    const formatted = formatWorkState(state);
    const latest = entries.at(-1);
    const rows: ReportRow[] = [
      ...(formatted
        ? lines(formatted)
        : [{ kind: "text", text: "No task state recorded yet.", tone: "muted" } as const]),
      { kind: "gap" },
      {
        kind: "field",
        key: "compactions",
        value: String(entries.length),
        ...(latest === undefined ? {} : { detail: `latest ${latest.recordedAt}` }),
      },
      { kind: "field", key: "stored", value: `${(sizeBytes / 1024).toFixed(1)}KB` },
      ...(latest === undefined
        ? []
        : [
            { kind: "gap" } as const,
            ...lines(
              latest.summary.length > WORK_SUMMARY_PREVIEW
                ? `${latest.summary.slice(0, WORK_SUMMARY_PREVIEW)}…`
                : latest.summary,
              "muted",
            ),
          ]),
    ];
    yield* terminal.log(report("work", rows, "Discard it with /work clear."));

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
): Effect.Effect<CommandResult, never, ToolRegistry | AgentConfigService | LLMService> {
  return Effect.gen(function* () {
    const toolRegistry = yield* ToolRegistryTag;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const { compactThresholdRatio } = resolveContextThresholds(appConfig.context);

    // Get model information
    const provider = agent.config.llm.provider;
    const servedVllm =
      provider === "vllm"
        ? yield* resolveVllmServerModel(agent.config.llm.model, appConfig.llm)
        : undefined;
    const servedSglang =
      provider === "sglang"
        ? yield* resolveSglangServerModel(agent.config.llm.model, appConfig.llm)
        : undefined;
    const modelId = servedVllm?.modelId ?? servedSglang?.modelId ?? agent.config.llm.model;
    const advertisedContextWindow = yield* getModelContextWindowEffect(modelId, provider);
    const serverContextWindow = servedVllm?.contextWindow ?? servedSglang?.contextWindow;
    const effectiveContextWindow = resolveEffectiveContextWindow({
      provider,
      ...(advertisedContextWindow !== undefined && { modelMaxTokens: advertisedContextWindow }),
      ...(serverContextWindow !== undefined && { serverContextWindow }),
      ...(typeof agent.config.llm.numCtx === "number" && {
        pinnedContextWindow: agent.config.llm.numCtx,
      }),
      ...(typeof agent.config.llm.maxContextTokens === "number" && {
        agentMaxTokens: agent.config.llm.maxContextTokens,
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

    const modelMaxTokens = effectiveContextWindow.modelMaxTokens;
    const windowNote = effectiveContextWindow.cappedByAgent
      ? `the agent caps the window${modelMaxTokens !== undefined ? `; the model allows ${formatCompactCount(modelMaxTokens)}` : ""}`
      : modelMaxTokens !== undefined && effectiveContextWindow.tokens < modelMaxTokens
        ? `the runtime serves a smaller window; the model allows ${formatCompactCount(modelMaxTokens)}`
        : undefined;
    const compactPercent = Math.round(compactThresholdRatio * 100);
    const count = (tokens: number): string => formatCompactCount(tokens);

    yield* terminal.log(
      report(
        "context",
        [
          {
            kind: "meter",
            used: adjustedUsage.totalUsed,
            total: contextWindow,
            caption: `${count(adjustedUsage.totalUsed)} of ${count(contextWindow)}`,
          },
          { kind: "field", key: "model", value: `${provider}/${modelId}` },
          { kind: "gap" },
          { kind: "field", key: "system", value: count(adjustedUsage.systemPromptTokens) },
          { kind: "field", key: "tools", value: count(adjustedUsage.toolsTokens) },
          { kind: "field", key: "skills", value: count(adjustedUsage.skillsTokens) },
          { kind: "field", key: "turns", value: count(adjustedUsage.messagesTokens) },
          { kind: "field", key: "free", value: count(adjustedUsage.freeSpace) },
        ],
        `Compacts at ${String(compactPercent)}%.${windowNote === undefined ? "" : ` ${windowNote.charAt(0).toUpperCase()}${windowNote.slice(1)}.`}`,
      ),
    );

    return { shouldContinue: true };
  });
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
    const { promptTokens, completionTokens } = sessionUsage;
    const totalTokens = promptTokens + completionTokens;
    const model = `${agent.config.llm.provider}/${agent.config.llm.model}`;

    if (totalTokens === 0) {
      yield* terminal.log(
        report("cost", [{ kind: "field", key: "model", value: model }], "No tokens used yet."),
      );
      return { shouldContinue: true };
    }

    const meta = yield* Effect.promise(() =>
      getModelsDevMetadata(agent.config.llm.model, agent.config.llm.provider),
    );
    const priced =
      meta?.inputPricePerMillion !== undefined || meta?.outputPricePerMillion !== undefined;
    const inputPricePerMillion = meta?.inputPricePerMillion ?? 0;
    const outputPricePerMillion = meta?.outputPricePerMillion ?? 0;
    const inputCost = (promptTokens / 1_000_000) * inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * outputPricePerMillion;

    const tokenRows: ReportRow[] = [
      {
        kind: "field",
        key: "input",
        value: promptTokens.toLocaleString(),
        ...(priced ? { detail: formatCost(inputCost) } : {}),
      },
      {
        kind: "field",
        key: "output",
        value: completionTokens.toLocaleString(),
        ...(priced ? { detail: formatCost(outputCost) } : {}),
      },
      {
        kind: "field",
        key: "total",
        value: totalTokens.toLocaleString(),
        ...(priced ? { detail: formatCost(inputCost + outputCost) } : {}),
      },
    ];
    yield* terminal.log(
      report(
        "cost",
        [{ kind: "field", key: "model", value: model }, { kind: "gap" }, ...tokenRows],
        priced
          ? `Priced at $${inputPricePerMillion.toFixed(2)} in and $${outputPricePerMillion.toFixed(2)} out per million tokens.`
          : "models.dev has no pricing for this model, so no cost is shown.",
      ),
    );
    return { shouldContinue: true };
  });
}
