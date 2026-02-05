import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option } from "effect";
import { autoCheckForUpdate } from "./cli/auto-update";
import { CLIPresentationServiceLayer } from "./cli/presentation/cli-presentation-service";
import { InkPresentationServiceLayer } from "./cli/presentation/ink-presentation-service";
import { createToolRegistrationLayer } from "./core/agent/tools/register-tools";
import { createToolRegistryLayer } from "./core/agent/tools/tool-registry";
import { AgentConfigServiceTag } from "./core/interfaces/agent-config";
import { CLIOptionsTag } from "./core/interfaces/cli-options";
import { LoggerServiceTag } from "./core/interfaces/logger";
import { MCPServerManagerTag } from "./core/interfaces/mcp-server";
import { StorageServiceTag } from "./core/interfaces/storage";
import { TerminalServiceTag } from "./core/interfaces/terminal";
import { SkillsLive } from "./core/skills/skill-service";
import type { JazzError } from "./core/types/errors";
import { handleError } from "./core/utils/error-handler";
import { resolveStorageDirectory } from "./core/utils/storage-utils";
import { promptInteractiveCatchUp } from "./core/workflows/catch-up";
import { SchedulerServiceLayer } from "./core/workflows/scheduler-service";
import { WorkflowsLive } from "./core/workflows/workflow-service";
import { createAgentServiceLayer } from "./services/agent-service";
import { createCalendarServiceLayer } from "./services/calendar";
import { createChatServiceLayer } from "./services/chat-service";
import { createConfigLayer } from "./services/config";
import { createFileSystemContextServiceLayer } from "./services/fs";
import { createGmailServiceLayer } from "./services/gmail";
import { createAISDKServiceLayer } from "./services/llm/ai-sdk-service";
import { createLoggerLayer } from "./services/logger";
import { createMCPServerManagerLayer } from "./services/mcp/mcp-server-manager";
import { NotificationServiceLayer } from "./services/notification";
import { FileStorageService } from "./services/storage/file";
import { createTerminalServiceLayer } from "./services/terminal";

/**
 * Configuration options for creating the application layer
 */
export interface AppLayerConfig {
  /**
   * Enable verbose logging
   */
  verbose?: boolean | undefined;

  /**
   * Enable debug logging
   */
  debug?: boolean | undefined;

  /**
   * Optional path to configuration file
   */
  configPath?: string | undefined;
}

/**
 * Create the application layer with all required services
 *
 * Composes all service layers including file system, configuration, logging,
 * storage, Gmail, LLM, tool registry, and agent services. This layer provides
 * all dependencies needed by the CLI commands.
 *
 * @param config - Configuration options for the application layer
 * @returns A complete Effect layer containing all application services
 *
 * @example
 * ```typescript
 * const appLayer = createAppLayer({ debug: true, configPath: "./config.json" });
 * yield* someCommand().pipe(Effect.provide(appLayer));
 * ```
 */

export function createAppLayer(config: AppLayerConfig = {}) {
  const { debug, configPath } = config;
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
    Layer.provide(terminalLayer),
  );

  const calendarLayer = createCalendarServiceLayer().pipe(
    Layer.provide(fileSystemLayer),
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
    Layer.provide(terminalLayer),
  );

  const llmLayer = createAISDKServiceLayer().pipe(
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
  );
  const toolRegistryLayer = createToolRegistryLayer();

  const shellLayer = createFileSystemContextServiceLayer().pipe(Layer.provide(fileSystemLayer));

  const mcpServerManagerLayer = createMCPServerManagerLayer()
    .pipe(Layer.provide(loggerLayer))
    .pipe(Layer.provide(configLayer));

  const toolRegistrationLayer = createToolRegistrationLayer().pipe(
    Layer.provide(toolRegistryLayer),
    Layer.provide(mcpServerManagerLayer),
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
    Layer.provide(terminalLayer),
    Layer.provide(SkillsLive.layer),
  );

  const agentLayer = createAgentServiceLayer().pipe(Layer.provide(storageLayer));

  const chatLayer = createChatServiceLayer().pipe(
    Layer.provide(terminalLayer),
    Layer.provide(loggerLayer),
    Layer.provide(shellLayer),
    Layer.provide(configLayer),
    Layer.provide(toolRegistryLayer),
    Layer.provide(agentLayer),
    Layer.provide(mcpServerManagerLayer),
    Layer.provide(SkillsLive.layer),
    Layer.provide(WorkflowsLive.layer),
  );

  // In TTY mode, keep Ink UI intact by routing all presentation output into Ink.
  // The legacy CLI presentation writes directly to stdout, which clobbers Ink rendering.
  const presentationLayer = process.stdout.isTTY
    ? InkPresentationServiceLayer.pipe(Layer.provide(NotificationServiceLayer))
    : CLIPresentationServiceLayer;

  // Create a complete layer by providing all dependencies
  return Layer.mergeAll(
    fileSystemLayer,
    configLayer,
    loggerLayer,
    terminalLayer,
    storageLayer,
    gmailLayer,
    calendarLayer,
    llmLayer,
    toolRegistryLayer,
    shellLayer,
    mcpServerManagerLayer,
    toolRegistrationLayer,
    agentLayer,
    chatLayer,
    presentationLayer,
    NotificationServiceLayer,
    SkillsLive.layer,
    WorkflowsLive.layer,
    SchedulerServiceLayer,
  );
}

/**
 * Run a CLI effect with graceful shutdown handling for termination signals.
 *
 * This ensures Ctrl+C / SIGTERM interruptions trigger fiber interruption so that
 * Effect finalizers run before the process exits.
 *
 * @param effect - The Effect to run
 * @param config - Configuration options for the application layer
 */
export function runCliEffect<R, E extends JazzError | Error>(
  effect: Effect.Effect<void, E, R>,
  config: AppLayerConfig = {},
  options: {
    /**
     * Skip scheduled workflow catch-up on startup.
     *
     * This is intended for `jazz workflow run`, so that manually running a workflow
     * doesn't also trigger catch-up execution for scheduled workflows.
     */
    readonly skipCatchUp?: boolean | undefined;
  } = {},
): void {
  const cliOptionsLayer = Layer.succeed(CLIOptionsTag, {
    verbose: config.verbose,
    debug: config.debug,
    configPath: config.configPath,
  });

  const program = Effect.gen(function* () {
    const shouldSkipCatchUp =
      process.env["JAZZ_DISABLE_CATCH_UP"] === "1" || options.skipCatchUp === true;

    if (!shouldSkipCatchUp) {
      // Interactive prompt for catch-up - asks user if they want to run missed workflows
      // Runs selected workflows in background, then continues with the original command
      yield* promptInteractiveCatchUp();
    }

    const fiber = yield* Effect.fork(autoCheckForUpdate().pipe(Effect.zipRight(effect)));
    let signalCount = 0;
    type SignalName = "SIGINT" | "SIGTERM";

    function handler(signal: SignalName): void {
      signalCount += 1;
      const label = signal === "SIGINT" ? "Ctrl+C" : signal;

      if (signalCount === 1) {
        process.stdout.write(`\nReceived ${label}. Shutting down...\n`);
        Effect.runFork(Fiber.interrupt(fiber));
      } else {
        process.stdout.write("\nForce exiting immediately. Some cleanup may be skipped.\n");
        throw new Error("Force exit requested (second termination signal)");
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

    // Register cleanup for MCP server connections
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Clear session id so shutdown logs go to the default log, not a workflow/catch-up session log
        const logger = yield* Effect.serviceOption(LoggerServiceTag);
        if (Option.isSome(logger)) {
          yield* logger.value.clearSessionId();
        }

        const mcpManager = yield* Effect.serviceOption(MCPServerManagerTag);
        if (Option.isSome(mcpManager)) {
          yield* mcpManager.value.disconnectAllServers().pipe(
            Effect.catchAll(() => Effect.void),
          );
        }
      }),
    );

    // Unmount Ink so the process can exit (Ink keeps stdin open otherwise).
    // Delay briefly so Ink can flush the last frame to stdout before we unmount.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const terminal = yield* Effect.serviceOption(TerminalServiceTag);
        if (Option.isSome(terminal) && terminal.value.cleanup) {
          yield* Effect.delay(
            Effect.sync(() => terminal.value.cleanup!()),
            Duration.millis(100),
          );
        }
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
  });

  const managedEffect = program.pipe(
    Effect.provide(Layer.mergeAll(createAppLayer(config), cliOptionsLayer)),
    Effect.scoped,
  ) as Effect.Effect<void, never, never>;

  void Effect.runPromise(managedEffect);
}
