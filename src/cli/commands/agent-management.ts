import chalk from "chalk";
import { Effect } from "effect";
import React from "react";
import {
  formatIsoShort,
  getTerminalWidth,
  padRight,
  truncateMiddle,
  wrapCommaList,
} from "@/cli/utils/string-utils";
import { getAgentByIdentifier, listAllAgents } from "@/core/agent/agent-service";
import { AgentServiceTag, type AgentService } from "@/core/interfaces/agent-service";
import { CLIOptionsTag, type CLIOptions } from "@/core/interfaces/cli-options";
import { ink, TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { StorageError, StorageNotFoundError } from "@/core/types/errors";
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
      readonly agentType?: string | undefined;
      readonly tools?: readonly string[] | undefined;
    };
  }[],
  options: { readonly verbose: boolean },
): string {
  const width = Math.max(60, Math.min(getTerminalWidth(), 120));

  const title = `Agents (${agents.length})`;
  const innerWidth = width - 2;
  const header = `┌${"─".repeat(innerWidth)}┐`;
  const footer = `└${"─".repeat(innerWidth)}┘`;

  const lines: string[] = [];
  lines.push(chalk.dim(header));

  const titleLine = ` ${chalk.bold(title)} ${chalk.dim(
    "— use `jazz agent get <id|name>` or `jazz agent chat <id|name>`",
  )}`;
  lines.push(chalk.dim("│") + padRight(titleLine, innerWidth) + chalk.dim("│"));
  lines.push(chalk.dim(`├${"─".repeat(innerWidth)}┤`));

  // Columns (keep conservative so we don't rely on perfect ANSI width measurement)
  const idxW = 3; // "12 "
  const nameW = Math.max(16, Math.min(28, Math.floor(innerWidth * 0.28)));
  const modelW = Math.max(18, Math.min(30, Math.floor(innerWidth * 0.25)));
  const typeW = Math.max(10, Math.min(14, Math.floor(innerWidth * 0.12)));
  const updatedW = 16; // "YYYY-MM-DD HH:mm"
  const gap = 2;

  const fixed =
    idxW + gap + nameW + gap + modelW + gap + typeW + gap + updatedW + gap; // last gap for padding
  const descW = Math.max(10, innerWidth - fixed);

  const colHeader =
    padRight("#", idxW) +
    " ".repeat(gap) +
    padRight("Name", nameW) +
    " ".repeat(gap) +
    padRight("Model", modelW) +
    " ".repeat(gap) +
    padRight("Type", typeW) +
    " ".repeat(gap) +
    padRight("Updated", updatedW) +
    " ".repeat(gap) +
    padRight("Description", descW);
  lines.push(chalk.dim("│") + " " + chalk.dim(truncateMiddle(colHeader, innerWidth - 1)) + chalk.dim("│"));
  lines.push(chalk.dim(`├${"─".repeat(innerWidth)}┤`));

  for (const [index, agent] of agents.entries()) {
    const idx = String(index + 1);
    const model = `${agent.config.llmProvider}/${agent.config.llmModel}`;
    const agentType = agent.config.agentType ?? "default";
    const updated = formatIsoShort(agent.updatedAt);

    const row =
      padRight(idx, idxW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(agent.name, nameW), nameW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(model, modelW), modelW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(agentType, typeW), typeW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(updated, updatedW), updatedW) +
      " ".repeat(gap) +
      padRight(truncateMiddle(agent.description ?? "", descW), descW);

    lines.push(chalk.dim("│") + " " + chalk.white(truncateMiddle(row, innerWidth - 1)) + chalk.dim("│"));

    const metaParts: string[] = [];
    metaParts.push(`${chalk.dim("id")} ${chalk.dim(truncateMiddle(agent.id, 28))}`);
    if (agent.config.reasoningEffort) {
      metaParts.push(`${chalk.dim("reasoning")} ${chalk.dim(String(agent.config.reasoningEffort))}`);
    }
    metaParts.push(`${chalk.dim("created")} ${chalk.dim(formatIsoShort(agent.createdAt))}`);

    const meta = metaParts.join(chalk.dim("  ·  "));
    lines.push(chalk.dim("│") + " " + padRight(meta, innerWidth - 1) + chalk.dim("│"));

    if (options.verbose) {
      const tools = agent.config.tools ?? [];
      const toolsLine =
        tools.length > 0
          ? `${chalk.dim("tools")} ${chalk.dim(`${tools.length}`)} ${chalk.dim("—")} ${chalk.dim(
              truncateMiddle(tools.join(", "), innerWidth - 20),
            )}`
          : `${chalk.dim("tools")} ${chalk.dim("none configured")}`;
      lines.push(chalk.dim("│") + " " + padRight(toolsLine, innerWidth - 1) + chalk.dim("│"));
    }

    lines.push(chalk.dim(`├${"─".repeat(innerWidth)}┤`));
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
 * List all agents via CLI command
 *
 * Retrieves and displays all available agents in a formatted table showing
 * their ID, name, description, and creation date.
 *
 * @returns An Effect that resolves when the agents are listed successfully
 *
 * @throws {StorageError} When there's an error accessing storage
 *
 * @example
 * ```typescript
 * yield* listAgentsCommand();
 * // Output: Table showing all agents with basic info
 * ```
 */
export function listAgentsCommand(): Effect.Effect<
  void,
  StorageError,
  AgentService | TerminalService | CLIOptions
> {
  return Effect.gen(function* () {
    const agents = yield* listAllAgents();
    const terminal = yield* TerminalServiceTag;
    const cliOptions = yield* CLIOptionsTag;

    if (agents.length === 0) {
      yield* terminal.info("No agents found. Create your first agent with: jazz agent create");
      return;
    }

    // Prefer a responsive Ink component (reflows on terminal resize).
    // Fall back to a plain string block when not in a TTY.
    if (process.stdout.isTTY) {
      yield* terminal.log(
        {
          _tag: "ink",
          node: React.createElement(AgentsList, {
            agents,
            verbose: cliOptions.verbose === true,
          }),
        },
      );
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
 * @param agentId - The unique identifier of the agent to delete
 * @returns An Effect that resolves when the agent is deleted successfully
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
 *
 * @example
 * ```typescript
 * yield* deleteAgentCommand("agent-123");
 * // Output: Confirmation message and deletion success
 * ```
 */
export function deleteAgentCommand(
  agentIdentifier: string,
): Effect.Effect<void, StorageError | StorageNotFoundError, AgentService | TerminalService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    const terminal = yield* TerminalServiceTag;

    // Resolve identifier (ID first, then fall back to matching by name)
    const agent = yield* getAgentByIdentifier(agentIdentifier);

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
 * @example
 * ```typescript
 * yield* getAgentCommand("agent-123");
 * yield* getAgentCommand("email-helper");
 * // Output: Detailed agent information including configuration
 * ```
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
              model: agent.model,
              createdAt: agent.createdAt,
              updatedAt: agent.updatedAt,
              config: {
                agentType: agent.config.agentType,
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
  readonly model?: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly config: {
    readonly agentType?: string | undefined;
    readonly llmProvider: string;
    readonly llmModel: string;
    readonly reasoningEffort?: string | undefined;
    readonly tools?: readonly string[] | undefined;
  };
}): string {
  const width = Math.max(60, Math.min(getTerminalWidth(), 120));
  const innerWidth = width - 2;

  const header = `┌${"─".repeat(innerWidth)}┐`;
  const footer = `└${"─".repeat(innerWidth)}┘`;
  const sep = `├${"─".repeat(innerWidth)}┤`;

  const model =
    agent.model?.trim().length ? agent.model : `${agent.config.llmProvider}/${agent.config.llmModel}`;
  const tools = agent.config.tools ?? [];

  const lines: string[] = [];
  lines.push(chalk.dim(header));
  lines.push(
    chalk.dim("│") +
      padRight(` ${chalk.bold(`Agent: ${agent.name}`)}`, innerWidth) +
      chalk.dim("│"),
  );
  lines.push(chalk.dim(sep));

  const kv = (k: string, v: string) =>
    chalk.dim("│") + padRight(` ${chalk.dim(k)} ${v}`, innerWidth) + chalk.dim("│");

  lines.push(kv("ID:", agent.id));
  lines.push(kv("Model:", model));
  lines.push(kv("Created:", agent.createdAt.toISOString()));
  lines.push(kv("Updated:", agent.updatedAt.toISOString()));
  lines.push(kv("Description:", agent.description?.trim().length ? agent.description : "—"));

  lines.push(chalk.dim(sep));
  lines.push(kv("Agent type:", agent.config.agentType ?? "default"));
  lines.push(kv("Provider:", agent.config.llmProvider));
  lines.push(kv("LLM model:", agent.config.llmModel));
  lines.push(kv("Reasoning:", agent.config.reasoningEffort ? String(agent.config.reasoningEffort) : "—"));

  lines.push(chalk.dim(sep));
  lines.push(
    chalk.dim("│") +
      padRight(` ${chalk.bold(`Tools (${tools.length})`)}${tools.length ? ":" : " — none configured"}`, innerWidth) +
      chalk.dim("│"),
  );

  if (tools.length > 0) {
    const wrapped = wrapCommaList(tools, Math.max(20, innerWidth - 4));
    for (const line of wrapped) {
      lines.push(chalk.dim("│") + padRight(`   ${line}`, innerWidth) + chalk.dim("│"));
    }
  }

  lines.push(chalk.dim(footer));
  return lines.join("\n");
}


