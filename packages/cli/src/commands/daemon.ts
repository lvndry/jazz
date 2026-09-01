/**
 * @fileoverview `jazz daemon` — run the HTTP server in the foreground.
 *
 * Foreground on purpose. Supervision is the host's job, and the host already has one: the
 * Telegram bridge ships as a container with an entrypoint, and scheduled workflows use
 * launchd. A daemon that forks and writes a pidfile would be a third mechanism competing
 * with both, and the first thing anyone deploying it would have to work around.
 *
 * `install`/`uninstall` do not change that — they don't add a jazz-owned supervision
 * mechanism, they wire this same foreground command into whichever supervisor the host
 * already has (systemd/launchd), which is exactly "the host's job" rather than a jazz pidfile
 * competing with it. See `@jazz/adapters/daemon/service-install` for that half.
 */

import { randomBytes } from "node:crypto";
import {
  DEFAULT_DAEMON_PORT,
  isLoopback,
  makeA2AHandler,
  makeHandler,
  makePeerHandler,
  makePeerInviteHandler,
  makeWebhookHandler,
  refuseReason,
  type DaemonRequirements,
} from "@jazz/adapters/daemon/server";
import {
  detectInitSystem,
  generateDaemonToken,
  type InstalledService,
  installService,
  serviceAlreadyInstalled,
  uninstallService,
} from "@jazz/adapters/daemon/service-install";
import {
  explainDaemonTokenProvisionFailure,
  resolveDaemonToken,
  resolveOrProvisionDaemonToken,
} from "@jazz/adapters/daemon/token";
import { runDueTriggers } from "@jazz/adapters/daemon/trigger-runner";
import { resolvePeerToken } from "@jazz/adapters/peers/token";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  keyringDelete,
  keyringSet,
} from "@jazz/adapters/secrets/keyring";
import { DAEMON_TOKEN_ENV_VAR, DAEMON_TOKEN_PATH } from "@jazz/adapters/secrets/registry";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { resolveWebhookToken } from "@jazz/adapters/webhooks/token";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import type { AppConfig } from "@jazz/core/types/config";
import { getJazzSchedulerInvocation } from "@jazz/core/utils/runtime";
import { SchedulerServiceTag } from "@jazz/core/workflows/scheduler-service";
import { Effect, Runtime } from "effect";

/** How often the daemon checks for due workflow schedules and wake triggers. */
const DEFAULT_TICK_INTERVAL_MS = 60_000;

export interface DaemonCommandOptions {
  readonly port: number;
  readonly host: string;
  /**
   * Agent that answers peer questions. Omitted means peers are not served at all.
   *
   * Opt-in rather than on-by-default: a daemon started to give its operator a local API
   * should not quietly also be answering strangers.
   */
  readonly peerAgent?: string | undefined;
}

/**
 * Explain a failed non-loopback token provision and, when peer serving was requested, give
 * the exact persistent-service command that stores the exported token safely for systemd or
 * launchd. Token provisioning belongs to adapters; this command-specific next step belongs
 * here, where the agent, host, and port are known.
 */
export function formatDaemonTokenProvisionFailure(
  failure: Parameters<typeof explainDaemonTokenProvisionFailure>[0],
  options: DaemonCommandOptions,
): string {
  const explanation = explainDaemonTokenProvisionFailure(failure);
  if (options.peerAgent === undefined) return explanation;

  return (
    `${explanation}\n\n` +
    `After exporting the token, install the persistent service:\n\n` +
    `  sudo -E jazz daemon install --serve-peers ${options.peerAgent} ` +
    `--host ${options.host} --port ${String(options.port)}`
  );
}

/**
 * The end state an install should leave an operator at: not just "the unit is enabled" but
 * "reachable, and here is the exact next command" — the whole point of verifying `/health`
 * inside `installService` is wasted if the message afterward still just points at
 * `systemctl status` and leaves peer-inviting as an exercise for the operator.
 */
function formatServiceInstalledMessage(
  installed: InstalledService,
  options: { readonly host: string },
): string {
  const statusCommand =
    installed.initSystem === "launchd"
      ? "launchctl list | grep jazz"
      : "systemctl status jazz-daemon";
  return (
    `Installed and started — the daemon answered its own health check, so it is actually ` +
    `reachable at ${options.host}, not just enabled.\n` +
    `Check on it anytime with '${statusCommand}'.\n\n` +
    `Next, invite a peer:\n\n` +
    `  jazz peers invite create <peer-name> --host ${options.host} --disclosure internal --expires 1h\n`
  );
}

/**
 * Serve until interrupted.
 *
 * The token comes from the environment or the OS keyring rather than a flag: a token in argv
 * is a token in `ps` output and in shell history, and this one authorises driving an agent.
 *
 * Loopback needs no token at all. A non-loopback host does, and rather than making a fresh
 * daemon unusable there until someone runs `jazz daemon set-token` by hand first, one is
 * generated and stored in the keyring automatically the first time — the daemon works from
 * the first run, at the cost of printing the token once so it can be copied to a client.
 */
export function daemonCommand(options: DaemonCommandOptions) {
  return Effect.gen(function* () {
    let token: string | undefined;
    if (isLoopback(options.host)) {
      token = yield* resolveDaemonToken();
    } else {
      const provisioned = yield* resolveOrProvisionDaemonToken();
      if (!provisioned.ok) {
        // A precise, OS-aware explanation instead of `refuseReason`'s generic "no token" —
        // provisioning already knows exactly why it failed, so say that instead of making
        // the operator rediscover it themselves.
        process.stderr.write(`${formatDaemonTokenProvisionFailure(provisioned, options)}\n`);
        process.exitCode = 1;
        return;
      }
      token = provisioned.token;
      if (provisioned.generated && provisioned.backend !== undefined) {
        process.stderr.write(
          `Generated a daemon token and stored it in ${describeKeyringBackend(provisioned.backend)}: ` +
            `${provisioned.token}\n` +
            `Use it as a bearer token from any client reaching this daemon over the network.\n`,
        );
      }
    }

    // Offer to make this persistent right where the operator would actually hit the need —
    // not a separate subcommand they'd have to already know exists. Only when there's an
    // agent to serve (install ties a unit to `--serve-peers`) and a token already resolved
    // for it; a loopback dev/test run is never offered this, matching "widening the bind is
    // a decision made twice" elsewhere in this file.
    if (!isLoopback(options.host) && options.peerAgent !== undefined && token !== undefined) {
      const initSystem = detectInitSystem();
      const terminal = yield* TerminalServiceTag;
      if (
        initSystem !== "unsupported" &&
        !serviceAlreadyInstalled(initSystem) &&
        terminal.isInteractive
      ) {
        if (process.getuid?.() !== 0) {
          yield* terminal.info(
            `Tip: run \`sudo jazz daemon install --serve-peers ${options.peerAgent} ` +
              `--host ${options.host}\` to make this a persistent service.`,
          );
        } else {
          yield* terminal.warn(
            "Not running as a persistent service yet — Ctrl+C or a closed session will kill it.",
          );
          const install = yield* terminal.confirm("Install it as a system service now?", false);
          if (install) {
            const invocation = yield* getJazzSchedulerInvocation();
            const installed = yield* installService({
              agentId: options.peerAgent,
              host: options.host,
              port: options.port,
              token,
              invocation,
            }).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  yield* terminal.error(error.message);
                  return undefined;
                }),
              ),
            );
            if (installed !== undefined) {
              yield* terminal.success(
                formatServiceInstalledMessage(installed, { host: options.host }),
              );
            }
            return;
          }
        }
      }
    }

    const daemonOptions = {
      port: options.port,
      host: options.host,
      ...(token !== undefined ? { token } : {}),
      ...(options.peerAgent !== undefined ? { peerAgent: options.peerAgent } : {}),
    };

    const refusal = refuseReason(daemonOptions);
    if (refusal !== undefined) {
      process.stderr.write(`${refusal}\n`);
      process.exitCode = 1;
      return;
    }

    const logger = yield* LoggerServiceTag;
    const scheduler = yield* SchedulerServiceTag;
    const runInProcessWorkflows = scheduler.getSchedulerType() === "in-process";

    // The whole agent stack, captured once. Each request runs on this rather than on a
    // fresh runtime: `Effect.runPromise` inside the handler would start with an empty
    // context and fail on the first service the runner asks for, which is exactly what it
    // did — with the unit tests passing throughout, because they inject a store directly
    // and never exercise the real layer.
    const runtime = yield* Effect.runtime<DaemonRequirements>();

    yield* Effect.async<void, never>((resume) => {
      const run = <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
        Runtime.runPromise(runtime)(effect as Effect.Effect<A, never, DaemonRequirements>);

      /**
       * Read live rather than once at startup.
       *
       * A peer added by accepting an invite, or a webhook added by an external tool, must be
       * usable immediately — a snapshot taken here would silently undo the point of
       * accepting a peer over HTTP in the first place, and would make adding a webhook mean
       * "add a webhook and remember to bounce the daemon".
       */
      const readLive = <T>(select: (appConfig: AppConfig) => readonly T[]) =>
        run(
          Effect.gen(function* () {
            const service = yield* AgentConfigServiceTag;
            return select(yield* service.appConfig);
          }),
        );

      const resolvePeers = () => readLive((appConfig) => appConfig.peers ?? []);
      const resolveWebhooks = () => readLive((appConfig) => appConfig.webhooks ?? []);

      const handle = makeHandler(daemonOptions, run);
      const handlePeer = makePeerHandler(
        daemonOptions,
        resolvePeers,
        (peerName) => Effect.runPromise(resolvePeerToken(peerName)),
        run,
      );
      const handlePeerInvite = makePeerInviteHandler(run, undefined, daemonOptions.peerAgent);
      const handleWebhook = makeWebhookHandler(
        resolveWebhooks,
        (webhookName) => Effect.runPromise(resolveWebhookToken(webhookName)),
        run,
      );
      // A2A is a second door into the same peer-serving logic `handlePeer` already
      // authenticates and answers through — see `makeA2AHandler`'s own comment.
      const handleA2A = makeA2AHandler(
        daemonOptions,
        resolvePeers,
        (peerName) => Effect.runPromise(resolvePeerToken(peerName)),
        run,
      );

      const routes: readonly { readonly prefix: string; readonly handle: typeof handle }[] = [
        { prefix: "/peer/", handle: handlePeer },
        { prefix: "/peer-invites/", handle: handlePeerInvite },
        { prefix: "/webhooks/", handle: handleWebhook },
        // The pre-rename URL stays routed: it is written into other people's webhook
        // settings, which jazz has no way to update.
        { prefix: "/a2a", handle: handleA2A },
        { prefix: "/.well-known/", handle: handleA2A },
      ];

      const server = Bun.serve({
        port: daemonOptions.port,
        hostname: daemonOptions.host,
        fetch: (request) => {
          const pathname = new URL(request.url).pathname;
          const route = routes.find((candidate) => pathname.startsWith(candidate.prefix));
          return (route?.handle ?? handle)(request);
        },
      });

      process.stderr.write(
        `jazz daemon listening on http://${daemonOptions.host}:${String(server.port)}` +
          `${token === undefined ? " (no token: loopback only)" : ""}\n`,
      );

      // In-process alternative to depending on launchd/crontab existing on the host: every
      // tick, run whatever workflow catch-up is due and fire any self-registered wake
      // triggers. A tick that throws is logged and swallowed — one bad tick must never stop
      // the next one from firing.
      const tickIntervalMs = (() => {
        const raw = process.env["JAZZ_DAEMON_TICK_MS"];
        const parsed = raw !== undefined ? Number(raw) : Number.NaN;
        return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TICK_INTERVAL_MS;
      })();

      let tickRunning = false;
      const ticker = setInterval(() => {
        if (tickRunning) return;
        tickRunning = true;
        void run(
          runDueTriggers({ runWorkflows: runInProcessWorkflows }).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                process.stderr.write(`jazz daemon tick failed: ${String(error)}\n`);
              }),
            ),
          ) as Effect.Effect<void, unknown, DaemonRequirements>,
        ).finally(() => {
          tickRunning = false;
        });
      }, tickIntervalMs);

      const stop = (): void => {
        // Not awaited: the process is going away, and blocking the signal handler on a
        // drain that may never finish is how a daemon becomes unkillable.
        clearInterval(ticker);
        void server.stop(true);
        resume(Effect.void);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      return Effect.sync(() => {
        clearInterval(ticker);
        void server.stop(true);
      });
    });

    yield* logger.info("Daemon stopped");
  }).pipe(Effect.provide(makeFileRunStoreLayer()));
}

/**
 * Store the daemon's bearer token in the OS keyring, generating one if `$JAZZ_DAEMON_TOKEN`
 * isn't set.
 *
 * Unlike a peer's token, nobody else needs to independently know this one — it only
 * authenticates *this* operator to *their own* daemon — so there is nothing wrong with Jazz
 * inventing it. `$JAZZ_DAEMON_TOKEN` is still honored when set, e.g. to reuse a token already
 * deployed to a container as a secret.
 */
export function setDaemonTokenCommand() {
  return Effect.gen(function* () {
    const fromEnv = process.env[DAEMON_TOKEN_ENV_VAR];
    const generated = fromEnv === undefined || fromEnv.trim().length === 0;
    const token = generated ? randomBytes(24).toString("hex") : fromEnv.trim();

    const backend = yield* detectKeyringBackend();
    if (backend === "none") {
      process.stderr.write(
        "$JAZZ_DISABLE_KEYRING is set, so Jazz won't store this token anywhere — unset it and " +
          "run this again, or persist the token yourself (a systemd `Environment=` line, your " +
          "shell profile).\n",
      );
      process.exitCode = 1;
      return;
    }

    const stored = yield* keyringSet(backend, DAEMON_TOKEN_PATH, token);
    if (!stored) {
      process.stderr.write(
        "Could not store the daemon token — neither the OS keyring nor the " +
          "$JAZZ_HOME/secrets.json fallback could be written to. Check that $JAZZ_HOME is " +
          "actually writable.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      generated
        ? `Generated and stored a daemon token in ${describeKeyringBackend(backend)}.\n`
        : `Stored the daemon token in ${describeKeyringBackend(backend)}.\n`,
    );
  });
}

export function forgetDaemonTokenCommand() {
  return Effect.gen(function* () {
    const backend = yield* detectKeyringBackend();
    yield* keyringDelete(backend, DAEMON_TOKEN_PATH);
    process.stdout.write("Removed the stored daemon token.\n");
  });
}

/**
 * The explicit escape hatch for the ambient prompt inside `daemonCommand()` — scriptable
 * (`--yes` skips the confirm, same convention `mcp.ts`'s trust command uses) and the way to
 * reinstall after changing `--host`/`--port`/`--serve-peers` without going through it again.
 */
export function installDaemonServiceCommand(options: {
  readonly agentId: string;
  readonly host: string;
  readonly port: number;
  readonly yes?: boolean;
}) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    if (options.yes !== true) {
      yield* terminal.warn(
        `This writes a system-level unit and enables+starts it via systemctl/launchctl.`,
      );
      const confirmed = yield* terminal.confirm("Continue?", false);
      if (!confirmed) {
        yield* terminal.info("Cancelled.");
        return;
      }
    }

    const existing = yield* resolveDaemonToken();
    const token = existing ?? generateDaemonToken();
    const invocation = yield* getJazzSchedulerInvocation();

    const installed = yield* installService({
      agentId: options.agentId,
      host: options.host,
      port: options.port,
      token,
      invocation,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
          return undefined;
        }),
      ),
    );
    if (installed === undefined) return;

    yield* terminal.success(formatServiceInstalledMessage(installed, { host: options.host }));
  });
}

export function uninstallDaemonServiceCommand(options: { readonly yes?: boolean }) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;

    if (options.yes !== true) {
      yield* terminal.warn("This stops the service, disables it, and removes its unit/env file.");
      const confirmed = yield* terminal.confirm("Continue?", false);
      if (!confirmed) {
        yield* terminal.info("Cancelled.");
        return;
      }
    }

    const failed = yield* uninstallService().pipe(
      Effect.as(false),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
          return true;
        }),
      ),
    );
    if (!failed) yield* terminal.success("Uninstalled.");
  });
}

export { DEFAULT_DAEMON_PORT };
