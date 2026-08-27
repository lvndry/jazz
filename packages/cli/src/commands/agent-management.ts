/**
 * `jazz agent` — list, inspect, and delete agents.
 */

import { getAgentByIdentifier, listAllAgents } from "@jazz/core/agent/agent-service";
import { sortAgents } from "@jazz/core/agent/agent-sort";
import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { CLIOptionsTag, type CLIOptions } from "@jazz/core/interfaces/cli-options";
import { JazzStateServiceTag, type JazzStateService } from "@jazz/core/interfaces/jazz-state";
import { ink, TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import type { Agent } from "@jazz/core/types/agent";
import { CLIError, StorageError, StorageNotFoundError } from "@jazz/core/types/errors";
import { agentModelString, formatProviderDisplayName } from "@jazz/core/utils/provider-model";
import chalk from "chalk";
import { Effect } from "effect";
import React from "react";
import { getGlyphs } from "@/cli/ui/glyphs";
import {
  formatIsoShort,
  getTerminalWidth,
  padRight,
  truncateMiddle,
  wrapCommaList,
} from "@/cli/utils/string-utils";
import {
  findAgentsWithCapability,
  type MediaCapability,
  suggestModelsForCapability,
} from "./media-agents";
import { AgentDetailsCard } from "../ui/AgentDetailsCard";
import { AgentsList } from "../ui/AgentsList";

function formatAgentsListBlock(
  agents: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string | undefined;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly config: {
      readonly llmProvider: string;
      readonly llmModel: string;
      readonly reasoningEffort?: string | undefined;
      readonly persona?: string | undefined;
      readonly tools?: readonly string[] | undefined;
    };
  }[],
  options: { readonly verbose: boolean },
): string {
  const width = Math.max(60, Math.min(getTerminalWidth(), 120));

  const g = getGlyphs();
  const title = `Agents (${agents.length})`;
  const innerWidth = width - 2;
  const header = `${g.boxTL}${g.boxH.repeat(innerWidth)}${g.boxTR}`;
  const footer = `${g.boxBL}${g.boxH.repeat(innerWidth)}${g.boxBR}`;
  const sep = `${g.boxML}${g.boxH.repeat(innerWidth)}${g.boxMR}`;

  const lines: string[] = [];
  lines.push(chalk.dim(header));

  const titleLine = ` ${chalk.bold(title)} ${chalk.dim(
    "— use `jazz agent get <id|name>` or `jazz agent chat <id|name>`",
  )}`;
  lines.push(chalk.dim(g.boxV) + padRight(titleLine, innerWidth) + chalk.dim(g.boxV));
  lines.push(chalk.dim(sep));

  // Columns (keep conservative so we don't rely on perfect ANSI width measurement)
  const idxW = 3; // "12 "
  const nameW = Math.max(16, Math.min(28, Math.floor(innerWidth * 0.28)));
  const modelW = Math.max(18, Math.min(30, Math.floor(innerWidth * 0.25)));
  const typeW = Math.max(10, Math.min(14, Math.floor(innerWidth * 0.12)));
  const reasoningW = 12; // "high/low"
  const gap = 2;

  const fixed = idxW + gap + nameW + gap + modelW + gap + typeW + gap + reasoningW + gap; // last gap for padding
  const descW = Math.max(10, innerWidth - fixed);

  const colHeader =
    padRight("#", idxW) +
    " ".repeat(gap) +
    padRight("Name", nameW) +
    " ".repeat(gap) +
    padRight("Model", modelW) +
    " ".repeat(gap) +
    padRight("Persona", typeW) +
    " ".repeat(gap) +
    padRight("Reasoning", reasoningW) +
    " ".repeat(gap) +
    padRight("Description", descW);
  lines.push(
    chalk.dim(g.boxV) +
      " " +
      chalk.dim(truncateMiddle(colHeader, innerWidth - 1)) +
      chalk.dim(g.boxV),
  );
  lines.push(chalk.dim(sep));

  for (const [index, agent] of agents.entries()) {
    const idx = String(index + 1);
    const model = `${agent.config.llmProvider}/${agent.config.llmModel}`;
    const persona = agent.config.persona ?? "default";
    const reasoning = agent.config.reasoningEffort ?? "—";

    const row =
      padRight(idx, idxW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(agent.name, nameW), nameW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(model, modelW), modelW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(persona, typeW), typeW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(reasoning, reasoningW), reasoningW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(agent.description ?? "", descW), descW);

    lines.push(
      chalk.dim(g.boxV) +
        " " +
        chalk.white(truncateMiddle(row, innerWidth - 1)) +
        chalk.dim(g.boxV),
    );

    const metaParts: string[] = [];
    metaParts.push(`${chalk.dim("id")} ${chalk.dim(truncateMiddle(agent.id, 28))}`);
    metaParts.push(`${chalk.dim("created")} ${chalk.dim(formatIsoShort(agent.createdAt))}`);
    metaParts.push(`${chalk.dim("updated")} ${chalk.dim(formatIsoShort(agent.updatedAt))}`);

    // Use a simple separator that's identical width in any font; the meta
    // line is dim throughout so visual weight is uniform.
    const meta = metaParts.join(chalk.dim("  -  "));
    lines.push(chalk.dim(g.boxV) + " " + padRight(meta, innerWidth - 1) + chalk.dim(g.boxV));

    if (options.verbose) {
      const tools = agent.config.tools ?? [];
      const toolsLine =
        tools.length > 0
          ? `${chalk.dim("tools")} ${chalk.dim(`${tools.length}`)} ${chalk.dim("-")} ${chalk.dim(
              truncateMiddle(tools.join(", "), innerWidth - 20),
            )}`
          : `${chalk.dim("tools")} ${chalk.dim("none configured")}`;
      lines.push(chalk.dim(g.boxV) + " " + padRight(toolsLine, innerWidth - 1) + chalk.dim(g.boxV));
    }

    lines.push(chalk.dim(sep));
  }

  // Replace last separator with footer for cleaner look
  lines[lines.length - 1] = chalk.dim(footer);
  return lines.join("\n");
}

/**
 * CLI commands for agent management
 *
 * These commands handle basic CRUD operations for agents including
 * listing, viewing details, and deletion.
 */

/**
 * Show the agents that can produce a given kind of media, or how to get one.
 *
 * Jazz cannot generate media on a model that does not do it — there is no tool to fall back on —
 * so "none of your agents can" has to come with the next step attached, or it is a dead end.
 */
function listAgentsWithCapability(
  agents: readonly Agent[],
  capability: MediaCapability,
  terminal: TerminalService,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const capable = yield* Effect.tryPromise({
      try: () => findAgentsWithCapability(agents, capability),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed([])));

    if (capable.length > 0) {
      yield* terminal.log(`Agents that can generate ${capability}:\n`);
      for (const { agent, supportsTools } of capable) {
        // Naming the tool gap matters: most media models cannot call tools at all, so an agent
        // that draws may be unable to read a file or search the web.
        const toolNote = supportsTools ? "" : "  (this model has no tools — generation only)";
        yield* terminal.log(`  ${agent.name}  ${agentModelString(agent.config)}${toolNote}`);
      }
      yield* terminal.log(`\nStart one with: jazz agent chat <name>`);
      return;
    }

    yield* terminal.log(`None of your agents can generate ${capability}.\n`);

    const providers = [...new Set(agents.map((agent) => agent.config.llmProvider))].filter(
      (provider) => provider.length > 0,
    );
    const suggestions = yield* Effect.tryPromise({
      try: () => suggestModelsForCapability(capability, providers),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed([])));

    if (suggestions.length === 0) {
      yield* terminal.log(
        `No model from your configured providers generates ${capability}. Gemini models are the ` +
          `most common source; add that provider with: jazz config set llm.gemini.api_key <key>`,
      );
      return;
    }

    yield* terminal.log("Models that can, from providers you already use:\n");
    for (const suggestion of suggestions) {
      const toolNote = suggestion.supportsTools ? "  (also supports tools)" : "";
      yield* terminal.log(`  ${suggestion.provider}/${suggestion.id}${toolNote}`);
    }
    yield* terminal.log(`\nCreate an agent on one with: jazz agent create`);
  });
}

/**
 * List all agents via CLI command
 *
 * Retrieves and displays all available agents in a formatted table showing
 * their ID, name, description, and creation date.
 *
 * @returns An Effect that resolves when the agents are listed successfully
 *
 * @throws {StorageError} When there's an error accessing storage
 *
 */
export function listAgentsCommand(
  options: { readonly can?: MediaCapability } = {},
): Effect.Effect<
  void,
  StorageError,
  AgentService | TerminalService | CLIOptions | JazzStateService
> {
  return Effect.gen(function* () {
    const agentsUnsorted = yield* listAllAgents();
    const terminal = yield* TerminalServiceTag;
    const cliOptions = yield* CLIOptionsTag;

    if (agentsUnsorted.length === 0) {
      yield* terminal.info("No agents found. Create your first agent with: jazz agent create");
      return;
    }

    if (options.can !== undefined) {
      yield* listAgentsWithCapability(agentsUnsorted, options.can, terminal);
      return;
    }

    // Sort with last-used agent first, then alphabetically
    const jazzState = yield* JazzStateServiceTag;
    const lastUsedAgentId = yield* jazzState.get("wizard.lastUsedAgentId").pipe(
      Effect.map((value) => (typeof value === "string" ? value : null)),
      Effect.catchAll(() => Effect.succeed(null)),
    );
    const agents = sortAgents(agentsUnsorted, lastUsedAgentId);

    // Ink component sized to the terminal width at print time (Static
    // scrollback cannot reflow after printing). Plain string block when
    // not in a TTY.
    if (process.stdout.isTTY) {
      yield* terminal.log({
        _tag: "ink",
        node: React.createElement(AgentsList, {
          agents,
          verbose: cliOptions.verbose === true,
        }),
      });
    } else {
      const block = formatAgentsListBlock(agents, { verbose: cliOptions.verbose === true });
      yield* terminal.log(block);
    }
  });
}

/**
 * Delete an agent via CLI command
 *
 * Removes the specified agent from storage after confirming the deletion.
 * This operation is irreversible and will permanently delete the agent
 * and all its associated data.
 *
 * @param agentIdentifier - The agent ID or name to delete
 * @param options - Deletion options
 * @param options.skipConfirmation - Delete without prompting (for `--yes`/`--force`)
 * @returns An Effect that resolves when the agent is deleted successfully
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
 * @throws {CLIError} When confirmation is required but the session is non-interactive
 *
 */
export function deleteAgentCommand(
  agentIdentifier: string,
  options: {
    readonly skipConfirmation?: boolean;
  } = {},
): Effect.Effect<
  void,
  StorageError | StorageNotFoundError | CLIError,
  AgentService | TerminalService
> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    const terminal = yield* TerminalServiceTag;

    // Resolve identifier (ID first, then fall back to matching by name)
    const agent = yield* getAgentByIdentifier(agentIdentifier);

    if (options.skipConfirmation !== true) {
      // A non-interactive terminal (non-TTY, quiet mode, JAZZ_NO_TUI) resolves
      // confirm() with the default (false) without asking, which would silently
      // abort — require an explicit --yes instead.
      if (terminal.isInteractive !== true) {
        return yield* Effect.fail(
          new CLIError({
            command: "agent delete",
            message: `deleting agent "${agent.name}" requires confirmation, but this session is not interactive`,
            suggestion: "Pass --yes (or --force) to delete without a confirmation prompt.",
          }),
        );
      }

      const model = `${agent.config.llmProvider}/${agent.config.llmModel}`;
      const confirmed = yield* terminal.confirm(
        `Delete agent "${agent.name}" (${model})? This cannot be undone.`,
        false,
      );

      if (!confirmed) {
        yield* terminal.info("Deletion cancelled.");
        return;
      }
    }

    // Delete the agent
    yield* agentService.deleteAgent(agent.id);

    yield* terminal.success("Agent deleted successfully!");
    yield* terminal.log(`   Name: ${agent.name}`);
    yield* terminal.log(`   ID: ${agent.id}`);
  });
}

/**
 * Get agent details via CLI command
 *
 * Retrieves and displays detailed information about a specific agent including
 * its configuration and metadata in a formatted output.
 *
 * @param agentIdentifier - The agent ID or name to retrieve
 * @returns An Effect that resolves when the agent details are displayed
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When no agent matches the provided identifier
 *
 */
export function getAgentCommand(
  agentIdentifier: string,
): Effect.Effect<void, StorageError | StorageNotFoundError, AgentService | TerminalService> {
  return Effect.gen(function* () {
    const agent = yield* getAgentByIdentifier(agentIdentifier);
    const terminal = yield* TerminalServiceTag;

    // In TTY mode, render a structured Ink card (single log entry, no noisy bullets).
    if (process.stdout.isTTY) {
      yield* terminal.log(
        ink(
          React.createElement(AgentDetailsCard, {
            agent: {
              id: agent.id,
              name: agent.name,
              description: agent.description,
              createdAt: agent.createdAt,
              updatedAt: agent.updatedAt,
              config: {
                persona: agent.config.persona,
                llmProvider: agent.config.llmProvider,
                llmModel: agent.config.llmModel,
                reasoningEffort: agent.config.reasoningEffort,
                tools: agent.config.tools ?? [],
              },
            },
          }),
        ),
      );
      return;
    }

    // Non-TTY: write a readable plain-text block (good for piping).
    yield* terminal.log(formatAgentDetailsBlock(agent));
  });
}

function formatAgentDetailsBlock(agent: {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly config: {
    readonly persona?: string | undefined;
    readonly llmProvider: string;
    readonly llmModel: string;
    readonly reasoningEffort?: string | undefined;
    readonly tools?: readonly string[] | undefined;
  };
}): string {
  const g = getGlyphs();
  const width = Math.max(60, Math.min(getTerminalWidth(), 120));
  const innerWidth = width - 2;

  const header = `${g.boxTL}${g.boxH.repeat(innerWidth)}${g.boxTR}`;
  const footer = `${g.boxBL}${g.boxH.repeat(innerWidth)}${g.boxBR}`;
  const sep = `${g.boxML}${g.boxH.repeat(innerWidth)}${g.boxMR}`;
  const v = chalk.dim(g.boxV);

  const model = agentModelString(agent.config);
  const tools = agent.config.tools ?? [];

  const lines: string[] = [];
  lines.push(chalk.dim(header));
  lines.push(v + padRight(` ${chalk.bold(`Agent: ${agent.name}`)}`, innerWidth) + v);
  lines.push(chalk.dim(sep));

  const kv = (k: string, val: string) => v + padRight(` ${chalk.dim(k)} ${val}`, innerWidth) + v;

  lines.push(kv("ID:", agent.id));
  lines.push(kv("Model:", model));
  lines.push(kv("Created:", agent.createdAt.toISOString()));
  lines.push(kv("Updated:", agent.updatedAt.toISOString()));
  lines.push(kv("Description:", agent.description?.trim().length ? agent.description : "-"));

  lines.push(chalk.dim(sep));
  lines.push(kv("Persona:", agent.config.persona ?? "default"));
  lines.push(kv("Provider:", formatProviderDisplayName(agent.config.llmProvider)));
  lines.push(kv("LLM model:", agent.config.llmModel));
  lines.push(
    kv("Reasoning:", agent.config.reasoningEffort ? String(agent.config.reasoningEffort) : "-"),
  );

  lines.push(chalk.dim(sep));
  lines.push(
    v +
      padRight(
        ` ${chalk.bold(`Tools (${tools.length})`)}${tools.length ? ":" : " - none configured"}`,
        innerWidth,
      ) +
      v,
  );

  if (tools.length > 0) {
    const wrapped = wrapCommaList(tools, Math.max(20, innerWidth - 4));
    for (const line of wrapped) {
      lines.push(v + padRight(`   ${line}`, innerWidth) + v);
    }
  }

  lines.push(chalk.dim(footer));
  return lines.join("\n");
}
