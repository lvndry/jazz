/**
 * @fileoverview `jazz daemon` — run the HTTP server in the foreground.
 *
 * Foreground on purpose. Supervision is the host's job, and the host already has one: the
 * Telegram bridge ships as a container with an entrypoint, and scheduled workflows use
 * launchd. A daemon that forks and writes a pidfile would be a third mechanism competing
 * with both, and the first thing anyone deploying it would have to work around.
 */

import { Effect, Runtime } from "effect";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import {
  DEFAULT_DAEMON_PORT,
  makeHandler,
  makePeerHandler,
  refuseReason,
  type DaemonRequirements,
} from "@/services/daemon/server";
import { detectKeyringBackend, keyringGet } from "@/services/secrets/keyring";
import { peerTokenPath } from "@/services/secrets/registry";
import { makeFileRunStoreLayer } from "@/services/storage/run-store";

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
 * The token comes from the environment rather than a flag: a token in argv is a token in
 * `ps` output and in shell history, and this one authorises driving an agent.
 */
export function daemonCommand(options: DaemonCommandOptions) {
  return Effect.gen(function* () {
    const token = process.env["JAZZ_DAEMON_TOKEN"];
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

    // The whole agent stack, captured once. Each request runs on this rather than on a
    // fresh runtime: `Effect.runPromise` inside the handler would start with an empty
    // context and fail on the first service the runner asks for, which is exactly what it
    // did — with the unit tests passing throughout, because they inject a store directly
    // and never exercise the real layer.
    const runtime = yield* Effect.runtime<DaemonRequirements>();

    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const peers = appConfig.peers ?? [];
    const keyringBackend = yield* detectKeyringBackend();

    yield* Effect.async<void, never>((resume) => {
      const run = <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>): Promise<A> =>
        Runtime.runPromise(runtime)(effect as Effect.Effect<A, never, DaemonRequirements>);

      const handle = makeHandler(daemonOptions, run);
      const handlePeer = makePeerHandler(
        daemonOptions,
        peers,
        (peerName) => Effect.runPromise(keyringGet(keyringBackend, peerTokenPath(peerName))),
        run,
      );

      const server = Bun.serve({
        port: daemonOptions.port,
        hostname: daemonOptions.host,
        fetch: (request) =>
          new URL(request.url).pathname.startsWith("/peer/")
            ? handlePeer(request)
            : handle(request),
      });

      process.stderr.write(
        `jazz daemon listening on http://${daemonOptions.host}:${String(server.port)}` +
          `${token === undefined ? " (no token: loopback only)" : ""}\n`,
      );

      const stop = (): void => {
        // Not awaited: the process is going away, and blocking the signal handler on a
        // drain that may never finish is how a daemon becomes unkillable.
        void server.stop(true);
        resume(Effect.void);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      return Effect.sync(() => {
        void server.stop(true);
      });
    });

    yield* logger.info("Daemon stopped");
  }).pipe(Effect.provide(makeFileRunStoreLayer()));
}

export { DEFAULT_DAEMON_PORT };
