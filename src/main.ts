#!/usr/bin/env node

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Command } from "commander";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import packageJson from "../package.json";
import { gmailLoginCommand, gmailLogoutCommand, gmailStatusCommand } from "./cli/commands/auth";
import { chatWithAIAgentCommand, createAgentCommand } from "./cli/commands/chat-agent";
import { getConfigCommand, listConfigCommand, setConfigCommand } from "./cli/commands/config";
import { editAgentCommand } from "./cli/commands/edit-agent";
import { deleteAgentCommand, getAgentCommand, listAgentsCommand } from "./cli/commands/task-agent";
import { updateCommand } from "./cli/commands/update";
import { CLIPresentationServiceLayer } from "./cli/presentation/presentation-service";
import { createToolRegistrationLayer } from "./core/agent/tools/register-tools";
import { createToolRegistryLayer } from "./core/agent/tools/tool-registry";
import { AgentConfigServiceTag } from "./core/interfaces/agent-config";
import { StorageServiceTag } from "./core/interfaces/storage";
import { TerminalServiceTag } from "./core/interfaces/terminal";
import type { JazzError } from "./core/types/errors";
import { handleError } from "./core/utils/error-handler";
import { createAgentServiceLayer } from "./services/agent-service";
import { createConfigLayer } from "./services/config";
import { createFileSystemContextServiceLayer } from "./services/fs";
import { createGmailServiceLayer } from "./services/gmail";
import { createAISDKServiceLayer } from "./services/llm/ai-sdk-service";
import { createLoggerLayer } from "./services/logger";
import { FileStorageService } from "./services/storage/file";
import { resolveStorageDirectory } from "./services/storage/utils";
import { createTerminalServiceLayer, TerminalServiceImpl } from "./services/terminal";

/**
 * Main entry point for the Jazz CLI
 */

/**
 * Create the application layer with all required services
 *
 * Composes all service layers including file system, configuration, logging,
 * storage, Gmail, LLM, tool registry, and agent services. This layer provides
 * all dependencies needed by the CLI commands.
 *
 * @returns A complete Effect layer containing all application services
 *
 * @example
 * ```typescript
 * const appLayer = createAppLayer();
 * yield* someCommand().pipe(Effect.provide(appLayer));
 * ```
 */
function createAppLayer(debug?: boolean, configPath?: string) {
  const fileSystemLayer = NodeFileSystem.layer;
  const configLayer = createConfigLayer(debug, configPath).pipe(Layer.provide(fileSystemLayer));
  const loggerLayer = createLoggerLayer();
  const terminalLayer = createTerminalServiceLayer();

  const storageLayer = Layer.effect(
    StorageServiceTag,
    Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      const { storage } = yield* config.appConfig;
      const basePath = resolveStorageDirectory(storage);
      const fs = yield* FileSystem.FileSystem;
      return new FileStorageService(basePath, fs);
    }),
  ).pipe(Layer.provide(fileSystemLayer), Layer.provide(configLayer));

  const gmailLayer = createGmailServiceLayer().pipe(
    Layer.provide(fileSystemLayer),
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
  );

  const llmLayer = createAISDKServiceLayer().pipe(
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
  );
  const toolRegistryLayer = createToolRegistryLayer();

  const shellLayer = createFileSystemContextServiceLayer().pipe(Layer.provide(fileSystemLayer));

  const toolRegistrationLayer = createToolRegistrationLayer().pipe(
    Layer.provide(toolRegistryLayer),
    Layer.provide(shellLayer),
  );

  const agentLayer = createAgentServiceLayer().pipe(Layer.provide(storageLayer));

  const presentationLayer = CLIPresentationServiceLayer;

  // Create a complete layer by providing all dependencies
  return Layer.mergeAll(
    fileSystemLayer,
    configLayer,
    loggerLayer,
    terminalLayer,
    storageLayer,
    gmailLayer,
    llmLayer,
    toolRegistryLayer,
    shellLayer,
    toolRegistrationLayer,
    agentLayer,
    presentationLayer,
  );
}

/**
 * Run a CLI effect with graceful shutdown handling for termination signals.
 *
 * This ensures Ctrl+C / SIGTERM interruptions trigger fiber interruption so that
 * Effect finalizers run before the process exits.
 */
function runCliEffect<R, E extends JazzError | Error>(
  effect: Effect.Effect<void, E, R>,
  debugFlag?: boolean,
  configPath?: string,
): void {
  const managedEffect = Effect.scoped(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect);
      let signalCount = 0;
      type SignalName = "SIGINT" | "SIGTERM";

      function handler(signal: SignalName): void {
        signalCount += 1;
        const label = signal === "SIGINT" ? "Ctrl+C" : signal;

        if (signalCount === 1) {
          process.stdout.write(`\nReceived ${label}. Gracefully shutting down...\n`);
          Effect.runFork(Fiber.interrupt(fiber));
        } else {
          process.stdout.write("\nForce exiting immediately. Some cleanup may be skipped.\n");
          process.exit(1);
        }
      }

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGINT", handler);
          process.on("SIGTERM", handler);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGINT", handler);
            process.off("SIGTERM", handler);
          }),
      );

      const exit = yield* Fiber.await(fiber);

      if (Exit.isFailure(exit)) {
        if (Exit.isInterrupted(exit)) {
          return;
        }

        const maybeError = Cause.failureOption(exit.cause);
        if (Option.isSome(maybeError)) {
          yield* handleError(maybeError.value);
          return;
        }

        yield* handleError(new Error(Cause.pretty(exit.cause)));
        return;
      }
    }),
  ).pipe(
    Effect.provide(createAppLayer(debugFlag, configPath)),
    Effect.provideService(TerminalServiceTag, new TerminalServiceImpl()),
  ) as Effect.Effect<void, never, never>;

  void Effect.runPromise(managedEffect);
}

/**
 * Main CLI application entry point
 *
 * Sets up the Commander.js CLI program with all available commands including:
 * - Agent management (create, list, get, edit, delete, chat)
 * - Configuration management (get, set, list, validate)
 * - Authentication (Gmail login, logout, status)
 * - Logs viewing
 *
 * Each command is wrapped with proper error handling using the enhanced error handler
 * that provides actionable suggestions and recovery steps.
 *
 * @returns An Effect that sets up and parses the CLI program
 *
 * @example
 * ```typescript
 * Effect.runPromise(main()).catch(console.error);
 * ```
 */
function main(): Effect.Effect<void, never> {
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

    // Agent commands
    const agentCommand = program.command("agent").description("Manage agents");

    agentCommand
      .command("list")
      .alias("ls")
      .description("List all agents")
      .action(() => {
        const opts = program.opts();
        runCliEffect(
          listAgentsCommand({ verbose: Boolean(opts["verbose"]) }),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    agentCommand
      .command("create")
      .description("Create a new agent (interactive mode)")
      .action(() => {
        const opts = program.opts();
        runCliEffect(
          createAgentCommand(),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    agentCommand
      .command("get <agentId>")
      .description("Get an agent details")
      .action((agentId: string) => {
        const opts = program.opts();
        runCliEffect(
          getAgentCommand(agentId),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    agentCommand
      .command("edit <agentId>")
      .description("Edit an existing agent")
      .action((agentId: string) => {
        const opts = program.opts();
        runCliEffect(
          editAgentCommand(agentId),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    agentCommand
      .command("delete <agentId>")
      .alias("remove")
      .alias("rm")
      .description("Delete an agent")
      .action((agentId: string) => {
        const opts = program.opts();
        runCliEffect(
          deleteAgentCommand(agentId),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
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
          const opts = program.opts();
          const streamOption =
            options.noStream === true ? false : options.stream === true ? true : undefined;
          runCliEffect(
            chatWithAIAgentCommand(
              agentIdentifier,
              streamOption !== undefined ? { stream: streamOption } : {},
            ),
            Boolean(opts["debug"]),
            opts["config"] as string | undefined,
          );
        },
      );

    // Config commands
    const configCommand = program.command("config").description("Manage configuration");

    configCommand
      .command("get <key>")
      .description("Get a configuration value")
      .action((key: string) => {
        const opts = program.opts();
        runCliEffect(
          getConfigCommand(key),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    configCommand
      .command("set <key> [value]")
      .description("Set a configuration value")
      .action((key: string, value?: string) => {
        const opts = program.opts();
        runCliEffect(
          setConfigCommand(key, value),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    configCommand
      .command("show")
      .description("Show all configuration values")
      .action(() => {
        const opts = program.opts();
        runCliEffect(
          listConfigCommand(),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    // Auth commands
    const authCommand = program.command("auth").description("Manage authentication");
    const gmailAuthCommand = authCommand
      .command("gmail")
      .description("Gmail authentication commands");

    gmailAuthCommand
      .command("login")
      .description("Authenticate with Gmail")
      .action(() => {
        const opts = program.opts();
        runCliEffect(
          gmailLoginCommand(),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    gmailAuthCommand
      .command("logout")
      .description("Logout from Gmail")
      .action(() => {
        const opts = program.opts();
        runCliEffect(
          gmailLogoutCommand(),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    gmailAuthCommand
      .command("status")
      .description("Check Gmail authentication status")
      .action(() => {
        const opts = program.opts();
        runCliEffect(
          gmailStatusCommand(),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    // Update command
    program
      .command("update")
      .description("Update Jazz to the latest version")
      .option("--check", "Check for updates without installing")
      .action((options: { check?: boolean }) => {
        const opts = program.opts();
        runCliEffect(
          updateCommand(options),
          Boolean(opts["debug"]),
          opts["config"] as string | undefined,
        );
      });

    program.parse();
  });
}

Effect.runPromise(main()).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
