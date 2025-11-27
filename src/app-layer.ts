import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { CLIPresentationServiceLayer } from "./cli/presentation/presentation-service";
import { createToolRegistrationLayer } from "./core/agent/tools/register-tools";
import { createToolRegistryLayer } from "./core/agent/tools/tool-registry";
import { AgentConfigServiceTag } from "./core/interfaces/agent-config";
import { CLIOptionsTag } from "./core/interfaces/cli-options";
import { StorageServiceTag } from "./core/interfaces/storage";
import { TerminalServiceTag } from "./core/interfaces/terminal";
import type { JazzError } from "./core/types/errors";
import { handleError } from "./core/utils/error-handler";
import { resolveStorageDirectory } from "./core/utils/storage-utils";
import { createAgentServiceLayer } from "./services/agent-service";
import { createCalendarServiceLayer } from "./services/calendar";
import { createChatServiceLayer } from "./services/chat-service";
import { createConfigLayer } from "./services/config";
import { createFileSystemContextServiceLayer } from "./services/fs";
import { createGmailServiceLayer } from "./services/gmail";
import { createAISDKServiceLayer } from "./services/llm/ai-sdk-service";
import { createLoggerLayer } from "./services/logger";
import { FileStorageService } from "./services/storage/file";
import { createTerminalServiceLayer, TerminalServiceImpl } from "./services/terminal";

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

  const toolRegistrationLayer = createToolRegistrationLayer().pipe(
    Layer.provide(toolRegistryLayer),
    Layer.provide(shellLayer),
  );

  const agentLayer = createAgentServiceLayer().pipe(Layer.provide(storageLayer));

  const chatLayer = createChatServiceLayer().pipe(
    Layer.provide(terminalLayer),
    Layer.provide(loggerLayer),
    Layer.provide(shellLayer),
    Layer.provide(configLayer),
    Layer.provide(toolRegistryLayer),
    Layer.provide(agentLayer),
  );

  const presentationLayer = CLIPresentationServiceLayer;

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
    toolRegistrationLayer,
    agentLayer,
    chatLayer,
    presentationLayer,
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
    Effect.provide(createAppLayer(config)),
    Effect.provideService(TerminalServiceTag, new TerminalServiceImpl()),
    Effect.provideService(CLIOptionsTag, {
      verbose: config.verbose,
      debug: config.debug,
      configPath: config.configPath,
    }),
  ) as Effect.Effect<void, never, never>;

  void Effect.runPromise(managedEffect);
}
