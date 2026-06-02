import { Command } from "commander";
import { Effect } from "effect";
import packageJson from "../../package.json";
import { runCliEffect } from "../app-layer";
import {
  deleteAgentCommand,
  getAgentCommand,
  listAgentsCommand,
} from "./commands/agent-management";
import { chatWithAIAgentCommand } from "./commands/chat-agent";
import { getConfigCommand, listConfigCommand, setConfigCommand } from "./commands/config";
import { createAgentCommand } from "./commands/create-agent";
import { editAgentCommand } from "./commands/edit-agent";
import {
  addMcpServerCommand,
  listMcpServersCommand,
  removeMcpServerCommand,
  enableMcpServerCommand,
  disableMcpServerCommand,
} from "./commands/mcp";
import {
  createPersonaCommand,
  listPersonasCommand,
  showPersonaCommand,
  editPersonaCommand,
  deletePersonaCommand,
} from "./commands/persona";
import { isApprovalPolicyFlag, runAgentOnceCommand } from "./commands/run-agent";
import { updateCommand } from "./commands/update";
import { wizardCommand } from "./commands/wizard";
import {
  listWorkflowsCommand,
  showWorkflowCommand,
  runWorkflowCommand,
  scheduleWorkflowCommand,
  unscheduleWorkflowCommand,
  listScheduledWorkflowsCommand,
  catchupWorkflowCommand,
  workflowHistoryCommand,
} from "./commands/workflow";
import { parsePositiveInt } from "./utils/option-parsers";

/**
 * CLI Application setup and command registration
 *
 * This module handles all Commander.js setup and command registration,
 * keeping the main entry point focused on bootstrapping.
 */

interface CliOptions {
  verbose?: boolean;
  debug?: boolean;
  config?: string;
  output?: string;
  tui?: boolean;
}

/**
 * Register the one-shot `run` command — non-interactive agent invocation for
 * scripts and webhook handlers.
 */
function registerRunCommand(program: Command): void {
  program
    .command("run [prompt]")
    .description(
      "Run an agent once non-interactively (for scripts/webhooks). Prompt comes from the argument or piped stdin; the answer goes to stdout, all chatter to stderr.",
    )
    .requiredOption("--agent <agentId>", "Agent ID or name to run")
    .option("--json", "Emit a single JSON envelope { ok, answer, costUSD, tokenUsage, toolCalls }")
    .option(
      "--approval-policy <policy>",
      "Auto-approve tools up to a risk level: read-only | low-risk | high-risk (high-risk approves everything). Tools above the level are declined.",
    )
    .option(
      "--timeout <ms>",
      "Abort the run after this many milliseconds",
      parsePositiveInt("--timeout"),
    )
    .option(
      "--max-iterations <n>",
      "Maximum agent reasoning iterations for this run",
      parsePositiveInt("--max-iterations"),
    )
    .action(
      (
        prompt: string | undefined,
        options: {
          agent: string;
          json?: boolean;
          approvalPolicy?: string;
          timeout?: number;
          maxIterations?: number;
        },
      ) => {
        const opts = program.opts<CliOptions>();
        const json = options.json === true;

        if (options.approvalPolicy !== undefined && !isApprovalPolicyFlag(options.approvalPolicy)) {
          const message = `Invalid --approval-policy "${options.approvalPolicy}". Expected read-only, low-risk, or high-risk.`;
          if (json) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: message, costUSD: 0 })}\n`);
          } else {
            process.stderr.write(`${message}\n`);
          }
          process.exitCode = 1;
          return;
        }

        // Force plain terminal so Ink never mounts and writes to stdout; the
        // one-shot presentation layer keeps stdout clean for the payload.
        process.env["JAZZ_NO_TUI"] = "1";

        runCliEffect(
          runAgentOnceCommand(options.agent, prompt, {
            json,
            ...(options.approvalPolicy !== undefined && isApprovalPolicyFlag(options.approvalPolicy)
              ? { approvalPolicy: options.approvalPolicy }
              : {}),
            ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
            ...(options.maxIterations !== undefined
              ? { maxIterations: options.maxIterations }
              : {}),
          }),
          {
            verbose: opts.verbose,
            debug: opts.debug,
            configPath: opts.config,
          },
          { skipCatchUp: true, skipUpdateCheck: true },
        );
      },
    );
}

/**
 * Register agent-related commands
 */
function registerAgentCommands(program: Command): void {
  const agentCommand = program.command("agent").description("Manage agents");

  agentCommand
    .command("list")
    .alias("ls")
    .description("List all agents")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(listAgentsCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  agentCommand
    .command("create")
    .description("Create a new agent (interactive mode)")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(createAgentCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  agentCommand
    .command("show <agentId>")
    .description("Get an agent details")
    .action((agentId: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(getAgentCommand(agentId), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  agentCommand
    .command("edit <agentId>")
    .description("Edit an existing agent")
    .action((agentId: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(editAgentCommand(agentId), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  agentCommand
    .command("delete <agentId>")
    .alias("remove")
    .alias("rm")
    .description("Delete an agent")
    .action((agentId: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(deleteAgentCommand(agentId), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  agentCommand
    .command("chat <agentIdentifier>")
    .description("Start a chat with an AI agent by ID or name")
    .option("--stream", "Force streaming mode (real-time output)")
    .option("--no-stream", "Disable streaming mode")
    .option(
      "--max-iterations <n>",
      "Maximum agent reasoning iterations per turn (default 80)",
      parsePositiveInt("--max-iterations"),
    )
    .action(
      (
        agentIdentifier: string,
        options: {
          stream?: boolean;
          noStream?: boolean;
          maxIterations?: number;
        },
      ) => {
        const opts = program.opts<CliOptions>();
        const streamOption =
          options.noStream === true ? false : options.stream === true ? true : undefined;
        runCliEffect(
          chatWithAIAgentCommand(agentIdentifier, {
            ...(streamOption !== undefined ? { stream: streamOption } : {}),
            ...(options.maxIterations !== undefined
              ? { maxIterations: options.maxIterations }
              : {}),
          }),
          {
            verbose: opts.verbose,
            debug: opts.debug,
            configPath: opts.config,
          },
        );
      },
    );
}

/**
 * Register configuration-related commands
 */
function registerConfigCommands(program: Command): void {
  const configCommand = program.command("config").description("Manage configuration");

  configCommand
    .command("get <key>")
    .description("Get a configuration value")
    .action((key: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(getConfigCommand(key), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  configCommand
    .command("set <key> [value]")
    .description("Set a configuration value")
    .action((key: string, value?: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(setConfigCommand(key, value), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  configCommand
    .command("show")
    .description("Show all configuration values")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(listConfigCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });
}

/**
 * Register MCP server management commands
 */
function registerMCPCommands(program: Command): void {
  const mcpCommand = program.command("mcp").description("Manage MCP servers");

  const run = <R, E extends Error>(effect: Effect.Effect<void, E, R>) => {
    const opts = program.opts<CliOptions>();
    runCliEffect(effect, {
      verbose: opts.verbose,
      debug: opts.debug,
      configPath: opts.config,
    });
  };

  mcpCommand
    .command("add [json]")
    .description("Add an MCP server from JSON (inline, --file, or interactive)")
    .option("-f, --file <path>", "Read MCP server JSON from a file")
    .action((json?: string, options?: { file?: string }) => {
      run(addMcpServerCommand(json, options?.file));
    });

  mcpCommand
    .command("list")
    .alias("ls")
    .description("List all configured MCP servers")
    .action(() => run(listMcpServersCommand()));

  mcpCommand
    .command("remove")
    .alias("rm")
    .description("Remove an MCP server")
    .action(() => run(removeMcpServerCommand()));

  mcpCommand
    .command("enable")
    .description("Enable a disabled MCP server")
    .action(() => run(enableMcpServerCommand()));

  mcpCommand
    .command("disable")
    .description("Disable an enabled MCP server")
    .action(() => run(disableMcpServerCommand()));
}

/**
 * Register persona-related commands
 */
function registerPersonaCommands(program: Command): void {
  const personaCommand = program.command("persona").description("Manage personas");

  const run = <R, E extends Error>(effect: Effect.Effect<void, E, R>) => {
    const opts = program.opts<CliOptions>();
    runCliEffect(effect, {
      verbose: opts.verbose,
      debug: opts.debug,
      configPath: opts.config,
    });
  };

  personaCommand
    .command("create")
    .description("Create a new custom persona (interactive)")
    .action(() => run(createPersonaCommand()));

  personaCommand
    .command("list")
    .alias("ls")
    .description("List all personas (built-in + custom)")
    .action(() => run(listPersonasCommand()));

  personaCommand
    .command("show <identifier>")
    .description("Show details of a persona by name or ID")
    .action((identifier: string) => run(showPersonaCommand(identifier)));

  personaCommand
    .command("edit <identifier>")
    .description("Edit an existing custom persona")
    .action((identifier: string) => run(editPersonaCommand(identifier)));

  personaCommand
    .command("delete <identifier>")
    .alias("rm")
    .description("Delete a custom persona")
    .action((identifier: string) => run(deletePersonaCommand(identifier)));
}

/**
 * Register update command
 */
function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .alias("upgrade")
    .description("Update Jazz to the latest version")
    .option("--check", "Check for updates without installing")
    .action((options: { check?: boolean }) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(updateCommand(options), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });
}

/**
 * Register workflow-related commands
 */
function registerWorkflowCommands(program: Command): void {
  const workflowCommand = program.command("workflow").description("Manage and run workflows");

  workflowCommand
    .command("list")
    .alias("ls")
    .description("List all available workflows")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(listWorkflowsCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  workflowCommand
    .command("show <name>")
    .description("Show details of a workflow")
    .action((name: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(showWorkflowCommand(name), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  workflowCommand
    .command("run <name>")
    .description("Run a workflow once")
    .option("--auto-approve", "Auto-approve tool executions based on workflow policy")
    .option("--agent <agentId>", "Agent ID or name to use for this workflow run")
    .option(
      "--max-iterations <n>",
      "Maximum agent reasoning iterations (overrides the workflow's own setting)",
      parsePositiveInt("--max-iterations"),
    )
    .option(
      "--scheduled",
      "Indicates this run was triggered by the system scheduler (launchd/cron)",
    )
    .action(
      (
        name: string,
        options: {
          autoApprove?: boolean;
          agent?: string;
          maxIterations?: number;
          scheduled?: boolean;
        },
        command: Command,
      ) => {
        const opts = program.opts<CliOptions>();
        const isWorkflowRunCommand =
          command.name() === "run" && command.parent?.name() === "workflow";
        runCliEffect(
          runWorkflowCommand(name, options),
          {
            verbose: opts.verbose,
            debug: opts.debug,
            configPath: opts.config,
          },
          { skipCatchUp: isWorkflowRunCommand },
        );
      },
    );

  workflowCommand
    .command("schedule <name>")
    .description("Enable scheduled execution for a workflow")
    .action((name: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(scheduleWorkflowCommand(name), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  workflowCommand
    .command("unschedule <name>")
    .description("Disable scheduled execution for a workflow")
    .action((name: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(unscheduleWorkflowCommand(name), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  workflowCommand
    .command("scheduled")
    .description("List all scheduled workflows")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(listScheduledWorkflowsCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  workflowCommand
    .command("catchup")
    .description("List workflows that missed a scheduled run, select which to run, then run them")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(catchupWorkflowCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  workflowCommand
    .command("history [name]")
    .description("Show workflow run history")
    .action((name?: string) => {
      const opts = program.opts<CliOptions>();
      runCliEffect(workflowHistoryCommand(name), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });
}

/**
 * Create and configure the CLI application
 *
 * Sets up the Commander.js program with all available commands including:
 * - Agent management (create, list, get, edit, delete, chat)
 * - Configuration management (get, set, show)
 * - MCP server management
 * - Update command
 *
 * @returns An Effect that creates the configured Commander program
 */
export function createCLIApp(): Effect.Effect<Command, never> {
  return Effect.sync(() => {
    const program = new Command();

    program
      .name("jazz")
      .description(
        "Create and manage autonomous AI agents that execute real-world tasks (email, git, web, shell, and more)",
      )
      .version(packageJson.version);

    // Global options
    program
      .option("-v, --verbose", "Enable verbose logging")
      .option("--debug", "Enable debug level logging")
      .option("--config <path>", "Path to configuration file")
      .option(
        "--no-tui",
        "Disable TUI; use plain terminal output (for CI, scripts, small terminals)",
      )
      .option(
        "--output <mode>",
        "Output mode: rendered, hybrid (default), raw (no formatting), or quiet (suppress output)",
      );

    // Apply global options before any command runs
    program.hook("preAction", (thisCommand) => {
      const opts = thisCommand.optsWithGlobals();
      if (opts["tui"] === false) {
        process.env["JAZZ_NO_TUI"] = "1";
      }
      if (opts["output"]) {
        process.env["JAZZ_OUTPUT_MODE"] = opts["output"] as string;
      }
    });

    // Register all commands
    registerRunCommand(program);
    registerAgentCommands(program);
    registerPersonaCommands(program);
    registerConfigCommands(program);
    registerMCPCommands(program);
    registerUpdateCommand(program);
    registerWorkflowCommands(program);

    if (process.argv.length <= 2) {
      program.action(() => {
        const opts = program.opts<CliOptions>();
        runCliEffect(wizardCommand(), {
          verbose: opts.verbose,
          debug: opts.debug,
          configPath: opts.config,
        });
      });
    }

    return program;
  });
}
