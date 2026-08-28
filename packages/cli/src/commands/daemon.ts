/**
 * @fileoverview `jazz daemon` — run the HTTP server in the foreground.
 *
 * Foreground on purpose. Supervision is the host's job, and the host already has one: the
 * Telegram bridge ships as a container with an entrypoint, and scheduled workflows use
 * launchd. A daemon that forks and writes a pidfile would be a third mechanism competing
 * with both, and the first thing anyone deploying it would have to work around.
 */

import { randomBytes } from "node:crypto";
import {
  DEFAULT_DAEMON_PORT,
  isLoopback,
  makeHandler,
  makePeerHandler,
  makeTriggerHandler,
  refuseReason,
  type DaemonRequirements,
} from "@jazz/adapters/daemon/server";
import { resolveDaemonToken, resolveOrProvisionDaemonToken } from "@jazz/adapters/daemon/token";
import { runDueTriggers } from "@jazz/adapters/daemon/trigger-runner";
import { resolvePeerToken } from "@jazz/adapters/peers/token";
import { detectKeyringBackend, keyringDelete, keyringSet } from "@jazz/adapters/secrets/keyring";
import { DAEMON_TOKEN_ENV_VAR, DAEMON_TOKEN_PATH } from "@jazz/adapters/secrets/registry";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { resolveTriggerToken } from "@jazz/adapters/triggers/token";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
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
    const provisioned = isLoopback(options.host)
      ? { token: yield* resolveDaemonToken(), generated: false }
      : yield* resolveOrProvisionDaemonToken();
    const token = provisioned?.token;
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

    if (provisioned?.generated === true) {
      process.stderr.write(
        `Generated a daemon token and stored it in the OS keyring: ${provisioned.token}\n` +
          `Use it as a bearer token from any client reaching this daemon over the network.\n`,
      );
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

    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const peers = appConfig.peers ?? [];
    const triggers = appConfig.triggers ?? [];

    yield* Effect.async<void, never>((resume) => {
      const run = <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
        Runtime.runPromise(runtime)(effect as Effect.Effect<A, never, DaemonRequirements>);

      const handle = makeHandler(daemonOptions, run);
      const handlePeer = makePeerHandler(
        daemonOptions,
        peers,
        (peerName) => Effect.runPromise(resolvePeerToken(peerName)),
        run,
      );
      const handleTrigger = makeTriggerHandler(
        triggers,
        (triggerName) => Effect.runPromise(resolveTriggerToken(triggerName)),
        run,
      );

      const routes: readonly { readonly prefix: string; readonly handle: typeof handle }[] = [
        { prefix: "/peer/", handle: handlePeer },
        { prefix: "/triggers/", handle: handleTrigger },
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
        "No OS keyring is available, and the daemon token is not written to disk in plaintext.\n",
      );
      process.exitCode = 1;
      return;
    }

    const stored = yield* keyringSet(backend, DAEMON_TOKEN_PATH, token);
    if (!stored) {
      process.stderr.write("Could not store the daemon token.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      generated
        ? `Generated and stored a daemon token in the ${backend} keyring.\n`
        : `Stored the daemon token in the ${backend} keyring.\n`,
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

export { DEFAULT_DAEMON_PORT };
