import { Command } from "commander";
import { Effect } from "effect";
import packageJson from "../../package.json";
import { runCliEffect } from "../app-layer";
import {
  deleteAgentCommand,
  getAgentCommand,
  listAgentsCommand,
} from "./commands/agent-management";
import {
  googleLoginCommand,
  googleLogoutCommand,
  googleStatusCommand,
} from "./commands/auth/google";
import { chatWithAIAgentCommand } from "./commands/chat-agent";
import { getConfigCommand, listConfigCommand, setConfigCommand } from "./commands/config";
import { createAgentCommand } from "./commands/create-agent";
import { editAgentCommand } from "./commands/edit-agent";
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
    .action(
      (
        agentIdentifier: string,
        options: {
          stream?: boolean;
          noStream?: boolean;
        },
      ) => {
        const opts = program.opts<CliOptions>();
        const streamOption =
          options.noStream === true ? false : options.stream === true ? true : undefined;
        runCliEffect(
          chatWithAIAgentCommand(
            agentIdentifier,
            streamOption !== undefined ? { stream: streamOption } : {},
          ),
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
 * Register authentication-related commands
 */
function registerAuthCommands(program: Command): void {
  const authCommand = program.command("auth").description("Manage authentication");

  // Google authentication commands
  const googleAuthCommand = authCommand
    .command("google")
    .description("Google authentication commands (Gmail & Calendar)");

  googleAuthCommand
    .command("login")
    .description("Authenticate with Google (Gmail & Calendar)")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(googleLoginCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  googleAuthCommand
    .command("logout")
    .description("Logout from Google (Gmail & Calendar)")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(googleLogoutCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });

  googleAuthCommand
    .command("status")
    .description("Check Google authentication status (Gmail & Calendar)")
    .action(() => {
      const opts = program.opts<CliOptions>();
      runCliEffect(googleStatusCommand(), {
        verbose: opts.verbose,
        debug: opts.debug,
        configPath: opts.config,
      });
    });
}

/**
 * Register update command
 */
function registerUpdateCommand(program: Command): void {
  program
    .command("update")
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
    .action((name: string, options: { autoApprove?: boolean; agent?: string }, command: Command) => {
      const opts = program.opts<CliOptions>();
      const isWorkflowRunCommand = command.name() === "run" && command.parent?.name() === "workflow";
      runCliEffect(
        runWorkflowCommand(name, {
          ...(options.autoApprove === true ? { autoApprove: true } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
        }),
        {
          verbose: opts.verbose,
          debug: opts.debug,
          configPath: opts.config,
        },
        { skipCatchUp: isWorkflowRunCommand },
      );
    });

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
 * - Authentication (Google login, logout, status)
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
      .option("-q, --quiet", "Suppress output")
      .option("--debug", "Enable debug level logging")
      .option("--config <path>", "Path to configuration file");

    // Register all commands
    registerAgentCommands(program);
    registerConfigCommands(program);
    registerAuthCommands(program);
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
