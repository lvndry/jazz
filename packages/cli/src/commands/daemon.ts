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
  type ProvisionDaemonTokenResult,
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
import { OneShotPresentationServiceLayer } from "@jazz/core/presentation/oneshot-presentation-service";
import type { AppConfig } from "@jazz/core/types/config";
import { getJazzSchedulerInvocation } from "@jazz/core/utils/runtime";
import { SchedulerServiceTag } from "@jazz/core/workflows/scheduler-service";
import { Effect, Runtime } from "effect";

/**
 * How often the daemon checks for due wake triggers, reminders and jobs.
 *
 * Five seconds, not a minute, because the tick interval is the resolution of every duration the
 * agent is allowed to ask for: `register_trigger` accepts "30s" and a minute-long tick made that
 * a lie by up to a minute. The sweeps it drives now read unlocked and take a lock only when
 * something is actually due, so a tick with nothing to do is a handful of small reads.
 *
 * `JAZZ_DAEMON_TICK_MS` overrides it, down to a second, for anything that needs tighter timing.
 * Note what this is *not*: waking the agent every second. A model turn per second is nonsense at
 * any tick rate — that is `wait_for`'s job, which polls inside a single tool call. This interval
 * only bounds how late a scheduled wake-up is.
 */
const DEFAULT_TICK_INTERVAL_MS = 5_000;

/**
 * Cron has no sub-minute resolution, so re-deriving workflow due-ness on a five-second tick would
 * parse every schedule twelve times to reach the same answer. This bounds it to once a minute
 * regardless of how fast the ticker runs.
 */
const WORKFLOW_CATCH_UP_INTERVAL_MS = 60_000;

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

/** The token a daemon will serve behind, and the one thing worth telling the operator. */
export interface DaemonTokenDecision {
  /** Absent only when nothing could be stored and the bind is loopback, so it serves open. */
  readonly token: string | undefined;
  /** A line for stderr, or nothing when there is genuinely nothing new to say. */
  readonly notice: string | undefined;
}

/**
 * Turn a provisioning result into the token to serve behind and what to print.
 *
 * Separated from `daemonCommand` because that function binds a socket and then never
 * returns, which makes the interesting decision here — a freshly generated token has to be
 * shown, an already-stored one must not be reprinted into logs on every restart, and a
 * failure on loopback degrades rather than exits — untestable in place.
 */
export function decideDaemonToken(result: ProvisionDaemonTokenResult): DaemonTokenDecision {
  if (!result.ok) {
    return {
      token: undefined,
      notice:
        `Could not store a daemon token, so this daemon is answering on loopback with no ` +
        `credential — anything else running as any user on this machine can drive an agent ` +
        `with filesystem access through it. ` +
        `${explainDaemonTokenProvisionFailure(result)}`,
    };
  }

  // An already-stored token is reprinted nowhere: a daemon restarted by a supervisor would
  // otherwise write the secret into its logs on every start. `jazz daemon set-token` is the
  // way back to it.
  if (!result.generated || result.backend === undefined) {
    return { token: result.token, notice: undefined };
  }

  return {
    token: result.token,
    notice:
      `Generated a daemon token and stored it in ${describeKeyringBackend(result.backend)}: ` +
      `${result.token}\n` +
      `Every client of this daemon must send it as a bearer token. Run ` +
      `\`jazz daemon set-token\` to issue a new one if you lose it.`,
  };
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
 * Every bind gets a token, loopback included, generated and stored in the keyring the first
 * time rather than making a fresh daemon unusable until someone runs `jazz daemon set-token`
 * by hand. It is printed once, so it can be copied to a client.
 *
 * Loopback used to get none, on the reasoning that a port only this machine can reach needs
 * no credential. That reasoning does not survive contact with either of loopback's two real
 * neighbours: every other user account on a shared box, and every page in the operator's
 * browser. The browser half is answered structurally (see `browserRefusal` in the daemon's
 * server), but nothing except a token separates a tokenless loopback daemon from any other
 * local process, and what it is protecting is an agent with filesystem access.
 *
 * The one asymmetry left is what happens when there is nowhere to keep a token. A
 * non-loopback bind refuses to start — `refuseReason` has always said so. Loopback warns and
 * serves anyway: exiting would turn "the keyring is unavailable" into "jazz does not run
 * here", which is a worse trade than the exposure it prevents on a port only this machine
 * can reach.
 */
export function daemonCommand(options: DaemonCommandOptions) {
  return Effect.gen(function* () {
    const provisioned = yield* resolveOrProvisionDaemonToken();
    if (!provisioned.ok && !isLoopback(options.host)) {
      // A precise, OS-aware explanation instead of `refuseReason`'s generic "no token" —
      // provisioning already knows exactly why it failed, so say that instead of making
      // the operator rediscover it themselves.
      process.stderr.write(`${formatDaemonTokenProvisionFailure(provisioned, options)}\n`);
      process.exitCode = 1;
      return;
    }

    const decided = decideDaemonToken(provisioned);
    if (decided.notice !== undefined) process.stderr.write(`${decided.notice}\n`);
    const token = decided.token;

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
            yield* service.reloadIfChanged();
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
          `${token === undefined ? " (unauthenticated: no token could be stored)" : ""}\n`,
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
      let lastWorkflowCatchUpAt = 0;
      const ticker = setInterval(() => {
        if (tickRunning) return;
        tickRunning = true;
        const now = Date.now();
        const workflowsDue =
          runInProcessWorkflows && now - lastWorkflowCatchUpAt >= WORKFLOW_CATCH_UP_INTERVAL_MS;
        if (workflowsDue) lastWorkflowCatchUpAt = now;
        void run(
          runDueTriggers({ runWorkflows: workflowsDue }).pipe(
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
  }).pipe(
    // Every run this process serves — a webhook fire, a due trigger, a resumed park — is
    // unattended by construction: whoever launched `jazz daemon` is not sitting at whatever
    // terminal or process is actually asking. Without this the runtime falls back to
    // whichever presentation the CLI's own interactive session picked, which unconditionally
    // reports it can prompt for approval — so a run that genuinely needs a human never parks,
    // it just gets silently approved by the safe-mode policy instead.
    Effect.provide(OneShotPresentationServiceLayer),
    Effect.provide(makeFileRunStoreLayer()),
  );
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
    // A generated token is printed, because otherwise there is nowhere to read it back from
    // and this command is the recovery path for an operator who lost the one the daemon
    // printed at startup. A token that came from the environment is already in the
    // operator's hands, so it is not echoed.
    process.stdout.write(
      generated
        ? `Generated and stored a daemon token in ${describeKeyringBackend(backend)}: ${token}\n` +
            `Restart the daemon for it to take effect, then send it as a bearer token.\n`
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
