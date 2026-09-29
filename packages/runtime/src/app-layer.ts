/**
 * Composition root: builds the Effect `Layer` that wires every adapter
 * (storage, LLM, terminal, presentation, telemetry, ...) behind core's
 * service tags, then runs a command's effect against it.
 */

import path from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { createAgentServiceLayer } from "@jazz/adapters/agent-service";
import { createConfigLayer, validateConfigFiles } from "@jazz/adapters/config";
import { createFileSystemContextServiceLayer } from "@jazz/adapters/fs";
import { setConversationRetentionLimit } from "@jazz/adapters/history/conversation-history-service";
import { createJazzStateServiceLayer } from "@jazz/adapters/jazz-state";
import { createJobQueueServiceLayer } from "@jazz/adapters/job-queue-service";
import { createAISDKServiceLayer } from "@jazz/adapters/llm/ai-sdk-service";
import {
  createLoggerLayer,
  flushLogs,
  setLogFormat,
  setLogLevel,
  setLogRetention,
} from "@jazz/adapters/logger";
import { createMCPServerManagerLayer } from "@jazz/adapters/mcp/mcp-server-manager";
import { createMemoryServiceLayer } from "@jazz/adapters/memory-service";
import { NotificationServiceLayer } from "@jazz/adapters/notification";
import { createPeerLedgerServiceLayer } from "@jazz/adapters/peers/ledger";
import { createPeerTokenServiceLayer } from "@jazz/adapters/peers/token";
import { createPersonaRegistryServiceLayer } from "@jazz/adapters/persona-registry-service";
import { createPersonaServiceLayer } from "@jazz/adapters/persona-service";
import {
  createPluginRegistryServiceLayer,
  createPluginRuntimeServiceLayer,
  PluginModuleLoader,
  PluginRegistryServiceImpl,
} from "@jazz/adapters/plugins";
import { createReminderServiceLayer } from "@jazz/adapters/reminder-service";
import { createSkillRegistryServiceLayer } from "@jazz/adapters/skill-registry-service";
import { FileStorageService } from "@jazz/adapters/storage/file";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileLoopStoreLayer } from "@jazz/adapters/storage/loop-store";
import { createTelemetryServiceLayer } from "@jazz/adapters/telemetry/telemetry-service";
import { createWakeTriggerServiceLayer } from "@jazz/adapters/wake-trigger-service";
import { createWorkflowRegistryServiceLayer } from "@jazz/adapters/workflow-registry-service";
import { createWorkspaceServiceLayer } from "@jazz/adapters/workspace-service";
import { autoCheckForUpdate } from "@jazz/cli/auto-update";
import { promptInteractiveCatchUp } from "@jazz/cli/catch-up-prompt";
import { createChatServiceLayer } from "@jazz/cli/chat-service";
import { promptFailedRunsWarning } from "@jazz/cli/failed-run-prompt";
import { CLIPresentationServiceLayer } from "@jazz/cli/presentation/cli-presentation-service";
import { InkPresentationServiceLayer } from "@jazz/cli/presentation/ink-presentation-service";
import { createPlainTerminalServiceLayer, createTerminalServiceLayer } from "@jazz/cli/terminal";
import {
  decideFullscreen,
  type FullscreenEnvironment,
  type TerminalInputCapabilities,
  type TerminalOutputCapabilities,
} from "@jazz/cli/ui/terminal-capabilities";
import { initializeTheme } from "@jazz/cli/ui/theme";
import { createToolRegistrationLayer } from "@jazz/core/agent/tools/register-tools";
import { createToolRegistryLayer } from "@jazz/core/agent/tools/tool-registry";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { CLIOptionsTag } from "@jazz/core/interfaces/cli-options";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { MCPServerManagerTag } from "@jazz/core/interfaces/mcp-server";
import { StorageServiceTag } from "@jazz/core/interfaces/storage";
import { TelemetryServiceTag } from "@jazz/core/interfaces/telemetry";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { handleError, isUserCancellation } from "@jazz/core/presentation/error-handler";
import { QuietPresentationServiceLayer } from "@jazz/core/presentation/quiet-presentation-service";
import { SkillsLive } from "@jazz/core/skills/skill-service";
import { InteractiveTerminalRequiredError, type JazzError } from "@jazz/core/types/errors";
import { getCurrentCommandName } from "@jazz/core/utils/current-command";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { SIGNAL_EXIT_CODE, type ShutdownSignal } from "@jazz/core/utils/process";
import { killTrackedProcesses } from "@jazz/core/utils/process";
import { isOfflineMode } from "@jazz/core/utils/runtime";
import { resolveStorageDirectory } from "@jazz/core/utils/storage";
import { emitTelemetry } from "@jazz/core/utils/telemetry-emit";
import { SchedulerServiceLayer } from "@jazz/core/workflows/scheduler-service";
import { WorkflowsLive } from "@jazz/core/workflows/workflow-service";
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option } from "effect";
import { reportStartupFailure } from "./startup-failure";
import { validateAgents } from "./validate-agents";

/** Config used to select terminal and presentation layers. Exported for testing. */
export interface PresentationConfig {
  readonly isQuiet: boolean;
  readonly usePlainTerminal: boolean;
  readonly useCLIPresentation: boolean;
  readonly useFullscreen: boolean;
}

/**
 * Determine which terminal and presentation layers to use.
 * Pure and testable; createAppLayer uses this with process.env / process.stdout.
 */
interface EnvShape extends FullscreenEnvironment {
  readonly JAZZ_OUTPUT_MODE?: string;
  readonly JAZZ_NO_TUI?: string;
  readonly JAZZ_FULLSCREEN?: string;
}

export function getPresentationConfig(
  env: EnvShape = process.env as EnvShape,
  stdout: TerminalOutputCapabilities = process.stdout,
  stdin: TerminalInputCapabilities = process.stdin,
  // Alternate screen is discarded on exit. Only a command that stays until the
  // user leaves should ask for it; print-and-return is the default.
  session = false,
): PresentationConfig {
  const isQuiet = env.JAZZ_OUTPUT_MODE === "quiet";
  const rawOutput = env.JAZZ_OUTPUT_MODE === "raw";
  // Two different opt-outs, one step apart. `--no-tui` means what it says and
  // what its help text promises: no terminal UI at all, so nothing ever renders
  // into stdout. `jazz run` and `jazz workflow --json` rely on exactly that to
  // keep their payload parseable. `JAZZ_FULLSCREEN=0` is the narrower one —
  // keep an interactive interface, just not the alternate screen.
  const requestNoTui = env.JAZZ_NO_TUI === "1";
  const requestLegacyTui = env.JAZZ_FULLSCREEN === "0" || env.JAZZ_FULLSCREEN === "false";
  const decision = decideFullscreen(
    { requestPlain: requestNoTui || requestLegacyTui || rawOutput || isQuiet },
    env,
    stdout,
    stdin,
  );
  // Plain output is for print-and-exit modes and for sessions without a
  // terminal. A real terminal that is only too limited for the alternate screen
  // (CI, TERM=dumb, a screen reader, a tiny window) keeps the classic Ink
  // interface, which still prompts; plain prompts cannot show a menu at all.
  const noTerminal = stdout.isTTY !== true || stdin.isTTY !== true;
  const usePlainOutput = rawOutput || requestNoTui || noTerminal;

  return {
    isQuiet,
    usePlainTerminal: isQuiet || usePlainOutput,
    useCLIPresentation: !isQuiet && usePlainOutput,
    useFullscreen: decision.fullscreen && !isQuiet && !rawOutput && session,
  };
}

/** What a {@link ShutdownSignalTracker} does in the world, injected so tests can observe it. */
export interface ShutdownSignalEffects {
  readonly writeNotice: (message: string) => void;
  readonly requestShutdown: () => void;
  readonly reportStopped: (signal: ShutdownSignal) => void;
  readonly exit: (code: number) => void;
}

/**
 * How a CLI command reacts to SIGINT and SIGTERM.
 *
 * The first signal writes a notice to stderr and asks the command to stop
 * gracefully. A second one reports the stop and exits at once. Notices go to
 * stderr because stdout belongs to the command's output, which for
 * `jazz run --json` is exactly one envelope. The stop is reported at most once,
 * whichever path gets there first, and the exit code is 128 plus the first
 * signal's number (130 for SIGINT, 143 for SIGTERM).
 */
export class ShutdownSignalTracker {
  private firstSignal: ShutdownSignal | undefined;
  private signalCount = 0;
  private reported = false;

  constructor(private readonly effects: ShutdownSignalEffects) {}

  handle(signal: ShutdownSignal): void {
    this.signalCount += 1;
    if (this.signalCount === 1) {
      this.firstSignal = signal;
      const label = signal === "SIGINT" ? "Ctrl+C" : signal;
      this.effects.writeNotice(`\nReceived ${label}. Shutting down...\n`);
      this.effects.requestShutdown();
      return;
    }
    this.effects.writeNotice("\nForce exiting immediately. Some cleanup may be skipped.\n");
    this.reportStopped();
    this.effects.exit(SIGNAL_EXIT_CODE[this.firstSignal ?? signal]);
  }

  /** Report that a signal stopped the command, once, if a signal arrived. */
  reportStopped(): void {
    if (this.firstSignal === undefined || this.reported) {
      return;
    }
    this.reported = true;
    this.effects.reportStopped(this.firstSignal);
  }

  /** The first shutdown signal received, if any. */
  received(): ShutdownSignal | undefined {
    return this.firstSignal;
  }

  /** Whether a signal stopped the command, as opposed to arriving after it finished. */
  stopped(): boolean {
    return this.reported;
  }
}

/** Exit code for a command that needs a terminal it was not given. */
export const EXIT_CODE_NEEDS_TERMINAL = 2;

/**
 * The process exit code for a command whose effect failed. A failure never
 * exits 0 (CI relies on the exit code), except Ctrl+C during a prompt, which is
 * a cancellation and leaves the exit code alone. An interactive command started
 * without a terminal exits 2, so a script can tell it apart from a failed run.
 */
export function exitCodeForFailure(error: JazzError | Error): number | undefined {
  if (isUserCancellation(error)) {
    return undefined;
  }
  if (error instanceof InteractiveTerminalRequiredError) {
    return EXIT_CODE_NEEDS_TERMINAL;
  }
  return 1;
}

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

export function createAppLayer(
  config: AppLayerConfig = {},
  options: { readonly session?: boolean } = {},
) {
  const { debug, configPath } = config;
  const fileSystemLayer = NodeFileSystem.layer;
  const configLayer = createConfigLayer(debug, configPath).pipe(Layer.provide(fileSystemLayer));
  const jazzStateLayer = createJazzStateServiceLayer();
  const loggerLayer = createLoggerLayer();

  const logFormatLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* AgentConfigServiceTag;
      const appConfig = yield* config.appConfig;
      const format = appConfig.logging?.format ?? "plain";
      const level = appConfig.logging?.level ?? "info";
      setLogFormat(format);
      setLogLevel(level);
      setLogRetention({
        retentionDays: appConfig.logging?.retentionDays,
        maxTotalSizeMB: appConfig.logging?.maxTotalSizeMB,
      });
      setConversationRetentionLimit(appConfig.history?.maxConversationsPerAgent);
      initializeTheme({
        ...(appConfig.ui?.theme === undefined ? {} : { configured: appConfig.ui.theme }),
        ...(appConfig.ui?.canvas === undefined ? {} : { canvas: appConfig.ui.canvas }),
        themesDirectory: path.join(getJazzHomeDirectory(), "themes"),
      });
    }),
  ).pipe(Layer.provide(configLayer));

  const presentationConfig = getPresentationConfig(
    process.env as EnvShape,
    process.stdout,
    process.stdin,
    options.session === true,
  );

  const terminalLayer = presentationConfig.usePlainTerminal
    ? createPlainTerminalServiceLayer()
    : createTerminalServiceLayer({ fullscreen: presentationConfig.useFullscreen });

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
  );

  const telemetryLayer = createTelemetryServiceLayer().pipe(
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
  );

  const agentLayer = createAgentServiceLayer().pipe(Layer.provide(storageLayer));
  const personaLayer = createPersonaServiceLayer();
  const personaRegistryLayer = createPersonaRegistryServiceLayer();
  const pluginLoaderRef: { current?: PluginModuleLoader } = {};
  const pluginLifecycle = new PluginRegistryServiceImpl({
    pluginDirectory: path.join(getJazzHomeDirectory(), "plugins"),
    hasLoadedDigest: (digest) => pluginLoaderRef.current?.hasLoadedDigest(digest) === true,
  });
  const pluginLoader = new PluginModuleLoader({
    stateStore: pluginLifecycle.stateStore,
    installer: pluginLifecycle.installer,
  });
  pluginLoaderRef.current = pluginLoader;
  const pluginRegistryLayer = createPluginRegistryServiceLayer(pluginLifecycle);
  const pluginRuntimeLayer = createPluginRuntimeServiceLayer({
    loader: pluginLoader,
    secrets: pluginLifecycle.secrets,
  });
  const workflowRegistryLayer = createWorkflowRegistryServiceLayer();
  const skillRegistryLayer = createSkillRegistryServiceLayer();
  const memoryServiceLayer = createMemoryServiceLayer();
  const workspaceServiceLayer = createWorkspaceServiceLayer().pipe(Layer.provide(configLayer));
  const reminderServiceLayer = createReminderServiceLayer();
  const goalStoreLayer = makeFileGoalStoreLayer();
  const loopStoreLayer = makeFileLoopStoreLayer();
  const wakeTriggerServiceLayer = createWakeTriggerServiceLayer();
  const jobQueueServiceLayer = createJobQueueServiceLayer();
  const peerLedgerServiceLayer = createPeerLedgerServiceLayer();
  const peerTokenServiceLayer = createPeerTokenServiceLayer();

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

  // isQuiet: no output. useCLIPresentation: CLI (plain stdout). else: Ink UI.
  const presentationLayer = presentationConfig.isQuiet
    ? QuietPresentationServiceLayer
    : presentationConfig.useCLIPresentation
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
    jazzStateLayer,
    llmLayer,
    toolRegistryLayer,
    shellLayer,
    mcpServerManagerLayer,
    toolRegistrationLayer,
    agentLayer,
    personaLayer,
    personaRegistryLayer,
    pluginRegistryLayer,
    pluginRuntimeLayer,
    workflowRegistryLayer,
    skillRegistryLayer,
    memoryServiceLayer,
    workspaceServiceLayer,
    reminderServiceLayer,
    goalStoreLayer,
    loopStoreLayer,
    wakeTriggerServiceLayer,
    jobQueueServiceLayer,
    peerLedgerServiceLayer,
    peerTokenServiceLayer,
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
/**
 * Record the outcome of the CLI command that just finished.
 *
 * Only the command path is recorded — arguments and option values are omitted
 * because they routinely carry prompts and file paths.
 */
function emitCommandExecuted(
  exit: Exit.Exit<void, unknown>,
  durationMs: number,
): Effect.Effect<void> {
  const command = getCurrentCommandName();
  if (command === undefined) return Effect.void;

  return emitTelemetry((telemetry) =>
    telemetry.recordCommandExecuted({
      command,
      durationMs,
      success: Exit.isSuccess(exit),
    }),
  );
}

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
    /**
     * Skip the periodic "update available" notice on startup.
     *
     * Intended for machine-readable commands like `jazz run`, where the notice
     * box would otherwise corrupt the clean stdout payload.
     */
    readonly skipUpdateCheck?: boolean | undefined;
    /**
     * This command lives until the user leaves (chat, wizard, editor).
     * Print-and-exit commands must not set this — the alternate screen would
     * restore the previous buffer and the output would vanish.
     */
    readonly session?: boolean | undefined;
    /**
     * Called at most once when a shutdown signal stops the command before it
     * finished: after the command is interrupted, or just before the forced
     * exit on a second signal. `jazz run --json` uses it to print its one
     * failure envelope.
     */
    readonly onStoppedBySignal?: ((signal: ShutdownSignal) => void) | undefined;
  } = {},
): void {
  const cliOptionsLayer = Layer.succeed(CLIOptionsTag, {
    verbose: config.verbose,
    debug: config.debug,
    configPath: config.configPath,
  });

  const requestShutdownRef: { current: (() => void) | null } = { current: null };
  const shutdownSignals = new ShutdownSignalTracker({
    writeNotice: (message) => process.stderr.write(message),
    requestShutdown: () => requestShutdownRef.current?.(),
    reportStopped: (signal) => options.onStoppedBySignal?.(signal),
    exit: (code) => {
      killTrackedProcesses();
      process.exit(code);
    },
  });

  const program = Effect.gen(function* () {
    const commandStartedAt = Date.now();
    const shouldSkipCatchUp =
      process.env["JAZZ_DISABLE_CATCH_UP"] === "1" || options.skipCatchUp === true;

    if (!shouldSkipCatchUp) {
      // Interactive prompt for catch-up - asks user if they want to run missed workflows
      // Runs selected workflows in background, then continues with the original command
      yield* promptInteractiveCatchUp();

      // Surface scheduled workflows whose most recent run ended in failure
      // (agent missing, quota exceeded, network error, etc.). One-shot info
      // line — does not block the command.
      yield* promptFailedRunsWarning();
    }

    const shouldSkipUpdateCheck =
      process.env["JAZZ_DISABLE_UPDATE_CHECK"] === "1" ||
      isOfflineMode() ||
      options.skipUpdateCheck === true;
    const startupCheck = shouldSkipUpdateCheck ? Effect.void : autoCheckForUpdate();
    const fiber = yield* Effect.fork(startupCheck.pipe(Effect.zipRight(effect)));
    // Interrupt must run in this runtime, so the Node signal handler only requests it.
    type ShutdownRequest = { _tag: "request" };
    const handler = (signal: ShutdownSignal): void => shutdownSignals.handle(signal);

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
      requestShutdownRef.current = () => {
        requestShutdownRef.current = null;
        resume(Effect.succeed({ _tag: "request" }));
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

    yield* emitCommandExecuted(exit, Date.now() - commandStartedAt);

    // Register cleanup for MCP server connections and telemetry flush
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Clear session id so shutdown logs go to the default log, not a workflow/catch-up session log
        const logger = yield* Effect.serviceOption(LoggerServiceTag);
        if (Option.isSome(logger)) {
          yield* logger.value.clearLogGroup();
        }

        // Stop sampling and deliver buffered telemetry before shutdown.
        const telemetry = yield* Effect.serviceOption(TelemetryServiceTag);
        if (Option.isSome(telemetry)) {
          yield* telemetry.value.shutdown().pipe(Effect.catchAll(() => Effect.void));
        }

        const mcpManager = yield* Effect.serviceOption(MCPServerManagerTag);
        if (Option.isSome(mcpManager)) {
          yield* mcpManager.value.disconnectAllServers().pipe(Effect.catchAll(() => Effect.void));
        }

        yield* Effect.promise(flushLogs);
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
        shutdownSignals.reportStopped();
        return;
      }

      const maybeError = Cause.failureOption(exit.cause);
      if (Option.isSome(maybeError)) {
        yield* handleError(maybeError.value);
        const failureExitCode = exitCodeForFailure(maybeError.value);
        if (failureExitCode !== undefined) {
          process.exitCode = failureExitCode;
        }
        return;
      }

      yield* handleError(new Error(Cause.pretty(exit.cause)));
      process.exitCode = 1;
      return;
    }
  });

  const managedEffect = program.pipe(
    Effect.provide(
      Layer.mergeAll(
        createAppLayer(config, { session: options.session === true }),
        cliOptionsLayer,
      ),
    ),
    Effect.scoped,
    Effect.catchAll(reportStartupFailure),
  ) as Effect.Effect<void, never, never>;

  void Effect.runPromise(managedEffect).finally(() => {
    const received = shutdownSignals.received();
    if (received !== undefined) {
      process.exit(
        shutdownSignals.stopped() ? SIGNAL_EXIT_CODE[received] : (process.exitCode ?? 0),
      );
    }
  });
}

/**
 * Run config validation without building the app layer, which may itself be blocked by the
 * invalid file this recovery command is meant to diagnose.
 */
export async function runConfigValidation(configPath?: string): Promise<void> {
  const exit = await Effect.runPromiseExit(
    validateConfigFiles(configPath).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (Exit.isSuccess(exit)) {
    const detail =
      exit.value.paths.length === 0 ? "No configuration files found." : exit.value.paths.join(", ");
    console.log(`Configuration is valid. ${detail}`);
    const agents = await Effect.runPromise(validateAgents(exit.value.storageDirectory));
    for (const warning of agents.warnings) {
      console.error(`warning: ${warning}`);
    }
    if (agents.errors.length > 0) {
      console.error(`Agents have problems (${agents.errors.length}):`);
      for (const error of agents.errors) {
        console.error(`  ${error}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`Agents are valid (${agents.agentCount} checked).`);
    return;
  }

  const failure = Cause.failureOption(exit.cause);
  console.error(Option.isSome(failure) ? failure.value.message : Cause.pretty(exit.cause));
  process.exitCode = 1;
}
