/**
 * Constructs an isolated plugin session for one agent run. Registration, budget reservations,
 * provider disablement, and hook failures are deliberately scoped to this object.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import { Effect } from "effect";
import { recordDecisionUsage } from "@/core/agent/metrics/agent-run-metrics";
import type { PluginSession, PluginSessionOptions } from "@/core/interfaces/plugin-runtime";
import {
  DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
  PluginRuntimeError,
  type AdvisoryHookHandler,
  type AdvisoryHookId,
  type DecisionBatchResult,
  type DecisionProvider,
  type DecisionRequest,
  type LoadedPlugin,
  type PluginDecisionClient,
  type PluginHostApi,
  type PluginSecretDeclaration,
  type LifecycleEvent,
  type LifecycleEventId,
  type PluginCommandDeclaration,
  type PluginCommandRegistration,
  type PluginCommandResult,
  type PluginLifecycleRegistration,
  type PluginToolDeclaration,
  type PluginToolRegistration,
  type PluginToolResult,
  type SkillRouteOutcome,
} from "@/core/types/plugin";
import {
  validateDecisionRequest,
  validateDecisionResult,
  validatePluginManifest,
  validateSkillRouteDistribution,
  validateSkillRouteInput,
} from "./validation";

/**
 * Write bytes to the process's controlling terminal so a terminal escape (for example an OSC
 * notification) reaches the user even when a fullscreen TUI owns stdout. Falls back to stdout when
 * there is no controlling terminal, and never throws. This is the default `writeTerminalSequence`.
 */
function writeControllingTerminal(data: string): void {
  try {
    const tty = openSync("/dev/tty", "w");
    try {
      writeSync(tty, data);
    } finally {
      closeSync(tty);
    }
    return;
  } catch {
    // No controlling terminal; fall through to stdout only if it is itself a terminal.
  }
  // Never write to a piped/redirected stdout — an escape sequence would corrupt machine-readable
  // output (headless runs, `--json`). With no terminal to reach, drop the sequence.
  if (process.stdout.isTTY !== true) return;
  try {
    process.stdout.write(data);
  } catch {
    // Best-effort: a closed or non-writable stdout must never surface to the run.
  }
}

export interface PluginSessionFactoryOptions extends PluginSessionOptions {
  readonly plugins: readonly LoadedPlugin[];
  readonly resolveSecret: (
    pluginId: string,
    declaration: PluginSecretDeclaration,
  ) => Promise<string | undefined>;
  readonly reportFailure?: (pluginId: string, message: string) => void;
}

type RegisteredHook = {
  readonly pluginId: string;
  readonly handler: AdvisoryHookHandler<"route.skills">;
};

type RegisteredTool = {
  readonly pluginId: string;
  readonly declaration: PluginToolDeclaration;
  readonly handler: PluginToolRegistration["handler"];
};

type RegisteredCommand = {
  readonly pluginId: string;
  readonly declaration: PluginCommandDeclaration;
  readonly handler: PluginCommandRegistration["handler"];
};

type RegisteredLifecycle = {
  readonly pluginId: string;
  readonly handler: PluginLifecycleRegistration["handler"];
};

const toolError = (message: string): PluginToolResult => ({ content: message, isError: true });

const abstainedRoute = (reason: string): SkillRouteOutcome => ({ status: "abstained", reason });

function abstainedBatch(
  providerId: string,
  request: DecisionRequest,
  reason: string,
): DecisionBatchResult {
  return {
    providerId,
    model: "unavailable",
    latencyMs: 0,
    answers: request.questions.map(({ id }) => ({ id, outcome: { status: "abstained", reason } })),
  };
}

function deadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("plugin deadline exceeded"));
      reject(new Error("plugin deadline exceeded"));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]).finally(
    () => {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  );
}

/** Build and register trusted, already-authorized modules into a fresh per-run session. */
export function createPluginSession(
  options: PluginSessionFactoryOptions,
): Effect.Effect<PluginSession, PluginRuntimeError> {
  return Effect.try({
    try: () => {
      const hooks = new Map<AdvisoryHookId, RegisteredHook>();
      const tools = new Map<string, RegisteredTool>();
      const commands = new Map<string, RegisteredCommand>();
      const lifecycle = new Map<LifecycleEventId, RegisteredLifecycle[]>();
      const providers = new Set<string>();
      const disabledProviders = new Set<string>();
      let reservedCostUSD = 0;
      let closed = false;
      const timeoutMs = options.hookTimeoutMs ?? DEFAULT_PLUGIN_HOOK_TIMEOUT_MS;

      const registerPlugin = (plugin: LoadedPlugin): void => {
        const manifest = validatePluginManifest(plugin.manifest);
        if (plugin.module.apiVersion !== manifest.hostApi)
          throw new Error("module API version does not match manifest");
        const declarations = new Map(
          manifest.secrets.map((declaration) => [declaration.name, declaration]),
        );

        const api: PluginHostApi = {
          apiVersion: 1,
          hooks: {
            register: (id, handler) => {
              if (!manifest.hooks.includes(id))
                throw new Error(`plugin did not declare hook ${id}`);
              if (hooks.has(id)) throw new Error(`hook ${id} already has a handler in this run`);
              hooks.set(id, {
                pluginId: manifest.id,
                handler: handler as unknown as AdvisoryHookHandler<"route.skills">,
              });
            },
          },
          decisions: {
            registerProvider: (provider) => {
              if (!manifest.decisionProviders.includes(provider.id))
                throw new Error(`plugin did not declare decision provider ${provider.id}`);
              if (providers.has(provider.id))
                throw new Error(`decision provider ${provider.id} already registered`);
              providers.add(provider.id);
              return createDecisionClient(provider);
            },
          },
          tools: {
            register: (registration) => {
              const declaration = manifest.tools.find((tool) => tool.name === registration.name);
              if (declaration === undefined)
                throw new Error(`plugin did not declare tool ${registration.name}`);
              if (tools.has(registration.name))
                throw new Error(`tool ${registration.name} already has a handler in this run`);
              tools.set(registration.name, {
                pluginId: manifest.id,
                declaration,
                handler: registration.handler,
              });
            },
          },
          commands: {
            register: (registration) => {
              const declaration = manifest.commands.find(
                (command) => command.name === registration.name,
              );
              if (declaration === undefined)
                throw new Error(`plugin did not declare command ${registration.name}`);
              if (commands.has(registration.name))
                throw new Error(`command ${registration.name} already has a handler in this run`);
              commands.set(registration.name, {
                pluginId: manifest.id,
                declaration,
                handler: registration.handler,
              });
            },
          },
          lifecycle: {
            register: (registration) => {
              if (!manifest.lifecycleHooks.includes(registration.event))
                throw new Error(`plugin did not declare lifecycle event ${registration.event}`);
              const existing = lifecycle.get(registration.event) ?? [];
              existing.push({ pluginId: manifest.id, handler: registration.handler });
              lifecycle.set(registration.event, existing);
            },
          },
          secrets: {
            get: async (name) => {
              const declaration = declarations.get(name);
              if (!declaration)
                throw new Error(`secret ${name} was not declared by ${manifest.id}`);
              const value = await options.resolveSecret(manifest.id, declaration);
              if (declaration.required && value === undefined)
                throw new Error(`required secret ${name} is unavailable`);
              return value;
            },
          },
        };

        function createDecisionClient(provider: DecisionProvider): PluginDecisionClient {
          return {
            decide: async (unvalidatedRequest, context) => {
              const request = validateDecisionRequest(unvalidatedRequest);
              if (closed || disabledProviders.has(provider.id))
                return abstainedBatch(provider.id, request, "provider unavailable");
              const bound = provider.maxCostUSDPerBatch;
              if (options.maxCostUSD !== undefined && bound === undefined)
                return abstainedBatch(
                  provider.id,
                  request,
                  "provider has no reservable cost bound",
                );
              const current = options.currentRunCostUSD?.();
              if (options.maxCostUSD !== undefined && current === undefined)
                return abstainedBatch(provider.id, request, "run cost is unavailable");
              if (
                options.maxCostUSD !== undefined &&
                (current ?? 0) + reservedCostUSD + (bound ?? 0) > options.maxCostUSD
              )
                return abstainedBatch(provider.id, request, "run cost budget exhausted");
              reservedCostUSD += bound ?? 0;
              const started = Date.now();
              try {
                const result = validateDecisionResult(
                  request,
                  await deadline(
                    (signal) => provider.decide(request, { signal }),
                    timeoutMs,
                    context?.signal,
                  ),
                );
                const exceededBound = bound !== undefined && (result.costUSD ?? 0) > bound;
                const missingCappedCost =
                  options.maxCostUSD !== undefined &&
                  provider.networkBacked === true &&
                  result.costUSD === undefined;
                if (exceededBound || missingCappedCost) disabledProviders.add(provider.id);
                if (options.metrics !== undefined) {
                  recordDecisionUsage(options.metrics, {
                    ...(result.usage && {
                      inputTokens: result.usage.inputTokens,
                      outputTokens: result.usage.outputTokens,
                    }),
                    durationMs: Date.now() - started,
                    ...(result.costUSD !== undefined
                      ? { costUSD: result.costUSD }
                      : missingCappedCost && bound !== undefined
                        ? { costUSD: bound }
                        : {}),
                    costUnknown: provider.networkBacked === true && result.costUSD === undefined,
                  });
                }
                return exceededBound
                  ? abstainedBatch(
                      provider.id,
                      request,
                      "provider exceeded its declared cost bound",
                    )
                  : missingCappedCost
                    ? abstainedBatch(
                        provider.id,
                        request,
                        "provider omitted cost under a capped run",
                      )
                    : result;
              } catch (error) {
                options.reportFailure?.(
                  manifest.id,
                  error instanceof Error ? error.message : String(error),
                );
                return abstainedBatch(provider.id, request, "provider failed");
              } finally {
                reservedCostUSD -= bound ?? 0;
              }
            },
          };
        }

        plugin.module.register(api);
      };

      for (const plugin of options.plugins) registerPlugin(plugin);

      return {
        runHook: (id, rawInput) =>
          Effect.promise(async () => {
            if (closed) return abstainedRoute("plugin session closed");
            const registration = hooks.get(id);
            if (!registration) return abstainedRoute("no plugin handler");
            try {
              const input = validateSkillRouteInput(rawInput);
              const outcome = await deadline(
                (signal) => registration.handler(input, { signal }),
                timeoutMs,
              );
              if (outcome.status === "answered")
                validateSkillRouteDistribution(input, outcome.distribution);
              return outcome;
            } catch (error) {
              options.reportFailure?.(
                registration.pluginId,
                error instanceof Error ? error.message : String(error),
              );
              return abstainedRoute("plugin handler failed");
            }
          }),
        listTools: () =>
          [...tools.values()].map(({ pluginId, declaration }) => ({ ...declaration, pluginId })),
        runTool: (name, args) =>
          Effect.promise(async () => {
            if (closed) return toolError("plugin session closed");
            const registered = tools.get(name);
            if (!registered) return toolError(`no plugin handler for tool ${name}`);
            try {
              return await deadline((signal) => registered.handler(args, { signal }), timeoutMs);
            } catch (error) {
              options.reportFailure?.(
                registered.pluginId,
                error instanceof Error ? error.message : String(error),
              );
              return toolError(`tool ${name} failed`);
            }
          }),
        emitLifecycle: (event: LifecycleEvent) =>
          Effect.promise(async () => {
            if (closed) return;
            const handlers = lifecycle.get(event.event) ?? [];
            await Promise.allSettled(
              handlers.map(async (registered) => {
                try {
                  await deadline(
                    (signal) =>
                      registered.handler(event, {
                        signal,
                        writeTerminalSequence:
                          options.writeTerminalSequence ?? writeControllingTerminal,
                      }),
                    timeoutMs,
                  );
                } catch (error) {
                  options.reportFailure?.(
                    registered.pluginId,
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }),
            );
          }),
        listCommands: () =>
          [...commands.values()].map(({ pluginId, declaration }) => ({ ...declaration, pluginId })),
        runCommand: (name, args) =>
          Effect.promise(async (): Promise<PluginCommandResult> => {
            if (closed) return {};
            const registered = commands.get(name);
            if (!registered) return {};
            try {
              return await deadline(
                (signal) => registered.handler({ args }, { signal }),
                timeoutMs,
              );
            } catch (error) {
              options.reportFailure?.(
                registered.pluginId,
                error instanceof Error ? error.message : String(error),
              );
              return {};
            }
          }),
        close: () =>
          Effect.promise(async () => {
            if (closed) return;
            closed = true;
            await Promise.allSettled(
              options.plugins.map(({ module }) =>
                module.dispose
                  ? deadline(async () => module.dispose!(), timeoutMs)
                  : Promise.resolve(),
              ),
            );
            hooks.clear();
            tools.clear();
            commands.clear();
            lifecycle.clear();
            providers.clear();
            disabledProviders.clear();
          }),
      } satisfies PluginSession;
    },
    catch: (cause) => new PluginRuntimeError({ message: "failed to open plugin session", cause }),
  });
}
