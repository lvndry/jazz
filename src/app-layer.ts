import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option } from "effect";
import { autoCheckForUpdate } from "./cli/auto-update";
import { promptInteractiveCatchUp } from "./cli/catch-up-prompt";
import { CLIPresentationServiceLayer } from "./cli/presentation/cli-presentation-service";
import { InkPresentationServiceLayer } from "./cli/presentation/ink-presentation-service";
import { createToolRegistrationLayer } from "./core/agent/tools/register-tools";
import { createToolRegistryLayer } from "./core/agent/tools/tool-registry";
import { AgentConfigServiceTag } from "./core/interfaces/agent-config";
import { CLIOptionsTag } from "./core/interfaces/cli-options";
import { LoggerServiceTag } from "./core/interfaces/logger";
import { MCPServerManagerTag } from "./core/interfaces/mcp-server";
import { StorageServiceTag } from "./core/interfaces/storage";
import { TelemetryServiceTag } from "./core/interfaces/telemetry";
import { TerminalServiceTag } from "./core/interfaces/terminal";
import { QuietPresentationServiceLayer } from "./core/presentation/quiet-presentation-service";
import { SkillsLive } from "./core/skills/skill-service";
import type { JazzError } from "./core/types/errors";
import type { OutputMode } from "./core/types/output";
import { handleError } from "./core/utils/error-handler";
import { resolveStorageDirectory } from "./core/utils/storage-utils";
import { SchedulerServiceLayer } from "./core/workflows/scheduler-service";
import { WorkflowsLive } from "./core/workflows/workflow-service";
import { createAgentServiceLayer } from "./services/agent-service";
import { createChatServiceLayer } from "./services/chat-service";
import { createConfigLayer } from "./services/config";
import { createFileSystemContextServiceLayer } from "./services/fs";
import { createAISDKServiceLayer } from "./services/llm/ai-sdk-service";
import { createLoggerLayer, setLogFormat, setLogLevel } from "./services/logger";
import { createMCPServerManagerLayer } from "./services/mcp/mcp-server-manager";
import { NotificationServiceLayer } from "./services/notification";
import { createPersonaServiceLayer } from "./services/persona-service";
import { FileStorageService } from "./services/storage/file";
import { createTelemetryServiceLayer } from "./services/telemetry/telemetry-service";
import { createPlainTerminalServiceLayer, createTerminalServiceLayer } from "./services/terminal";

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
 * storage, LLM, tool registry, and agent services. This layer provides
 * all dependencies needed by the CLI commands.
 *
 * @param config - Configuration options for the application layer
 * @returns A complete Effect layer containing all application services
 *
 */

export function createAppLayer(config: AppLayerConfig = {}) {
  const { debug, configPath } = config;
  const fileSystemLayer = NodeFileSystem.layer;
  const configLayer = createConfigLayer(debug, configPath).pipe(Layer.provide(fileSystemLayer));
  const loggerLayer = createLoggerLayer();

  const logFormatLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      const appConfig = yield* config.appConfig;
      const format = appConfig.logging?.format ?? "plain";
      const level = appConfig.logging?.level ?? "info";
      setLogFormat(format);
      setLogLevel(level);
    }),
  ).pipe(Layer.provide(configLayer));

  // Determine output mode from JAZZ_OUTPUT_MODE env var (set by --output CLI flag or externally).
  // "quiet" mode forces plain terminal (no interactive prompts, no output).
  // Otherwise, auto-detect based on TTY status.
  const outputMode = process.env["JAZZ_OUTPUT_MODE"] as OutputMode | undefined;
  const isQuiet = outputMode === "quiet";

  const terminalLayer = isQuiet ? createPlainTerminalServiceLayer() : createTerminalServiceLayer();

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
    Layer.provide(SkillsLive.layer),
  );

  const telemetryLayer = createTelemetryServiceLayer().pipe(
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
  );

  const agentLayer = createAgentServiceLayer().pipe(Layer.provide(storageLayer));
  const personaLayer = createPersonaServiceLayer();

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

  // "quiet" mode: suppress all presentation output (QuietPresentationService no-ops everything).
  // Non-TTY (CI, pipes): use CLI presentation layer which writes directly to stdout.
  // TTY (interactive): use Ink UI for rich rendering.
  const presentationLayer = isQuiet
    ? QuietPresentationServiceLayer
    : !process.stdout.isTTY
      ? CLIPresentationServiceLayer
      : InkPresentationServiceLayer.pipe(Layer.provide(NotificationServiceLayer));

  // Create a complete layer by providing all dependencies
  return Layer.mergeAll(
    fileSystemLayer,
    configLayer,
    loggerLayer,
    logFormatLayer,
    terminalLayer,
    storageLayer,
    llmLayer,
    toolRegistryLayer,
    shellLayer,
    mcpServerManagerLayer,
    toolRegistrationLayer,
    agentLayer,
    personaLayer,
    chatLayer,
    telemetryLayer,
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

    // Ref so the Node signal handler can request shutdown; interrupt must run in this runtime.
    type ShutdownRequest = { _tag: "request" };
    const requestShutdownRef: { current: ((req: ShutdownRequest) => void) | null } = {
      current: null,
    };

    function handler(signal: SignalName): void {
      signalCount += 1;
      const label = signal === "SIGINT" ? "Ctrl+C" : signal;

      if (signalCount === 1) {
        process.stdout.write(`\nReceived ${label}. Shutting down...\n`);
        const notify = requestShutdownRef.current;
        if (notify) notify({ _tag: "request" });
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

    const shutdownRequest = Effect.async<ShutdownRequest>((resume) => {
      requestShutdownRef.current = (req) => {
        requestShutdownRef.current = null;
        resume(Effect.succeed(req));
      };
      return Effect.sync(() => {
        requestShutdownRef.current = null;
      });
    });

    const exit = yield* Effect.race(
      Fiber.await(fiber).pipe(Effect.map((exit) => ({ _tag: "exit" as const, exit }))),
      shutdownRequest.pipe(Effect.map((req) => ({ _tag: "signal" as const, req }))),
    )
      .pipe(
        Effect.flatMap((result) =>
          result._tag === "signal"
            ? Fiber.interrupt(fiber).pipe(
                Effect.zipRight(Fiber.await(fiber)),
                Effect.map((exit) => ({ _tag: "exit" as const, exit })),
              )
            : Effect.succeed(result),
        ),
      )
      .pipe(Effect.map((r) => r.exit));

    // Register cleanup for MCP server connections and telemetry flush
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Clear session id so shutdown logs go to the default log, not a workflow/catch-up session log
        const logger = yield* Effect.serviceOption(LoggerServiceTag);
        if (Option.isSome(logger)) {
          yield* logger.value.clearSessionId();
        }

        // Flush any buffered telemetry events before shutdown
        const telemetry = yield* Effect.serviceOption(TelemetryServiceTag);
        if (Option.isSome(telemetry)) {
          yield* telemetry.value.flush().pipe(Effect.catchAll(() => Effect.void));
        }

        const mcpManager = yield* Effect.serviceOption(MCPServerManagerTag);
        if (Option.isSome(mcpManager)) {
          yield* mcpManager.value.disconnectAllServers().pipe(Effect.catchAll(() => Effect.void));
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
