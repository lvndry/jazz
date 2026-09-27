/**
 * @fileoverview `jazz daemon status|pause|resume`: what the daemon is doing, what waits on you,
 * and stopping or restarting its background work.
 *
 * These read and write the stores and the daemon's state file directly, so they answer whether
 * or not a daemon is running; a running one picks a pause or resume up on its next tick.
 */

import { daemonStatusSnapshot, pauseDaemon, resumeDaemon } from "@jazz/adapters/daemon/attention";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileLoopStoreLayer } from "@jazz/adapters/storage/loop-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "@jazz/core/constants/daemon";
import type { WaitingItem } from "@jazz/core/daemon/attention";
import { isAgentStartedProcess } from "@jazz/core/utils/env";
import { getJazzInstanceId } from "@jazz/core/utils/instance-id";
import { formatCompactCount } from "@jazz/core/utils/string";
import { Effect } from "effect";
import { probeDaemonOwner } from "@/cli/helpers/daemon-process";
import { emitEnvelope, failEnvelope } from "@/cli/helpers/json-output";

/** How long `status` waits for a daemon to answer `/health` before calling it not running. */
const STATUS_PROBE_MS = 1_000;

const stores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(makeFileRunStoreLayer()),
    Effect.provide(makeFileGoalStoreLayer()),
    Effect.provide(makeFileLoopStoreLayer()),
  );

function describeItem(item: WaitingItem): string {
  const answer =
    item.runId !== undefined && item.kind === "approval"
      ? `jazz runs approve ${item.runId}  ·  jazz runs reject ${item.runId}`
      : item.runId !== undefined && item.kind === "question"
        ? `jazz runs answer ${item.runId} --response "<your answer>"`
        : item.goalId !== undefined
          ? `jazz goal show ${item.goalId.slice(0, 8)}`
          : item.loopId !== undefined
            ? `jazz loop show ${item.loopId.slice(0, 8)}`
            : undefined;
  return [
    `  • ${item.title}`,
    `    ${item.detail.split("\n").join(" ")}`,
    ...(answer !== undefined ? [`    ${answer}`] : []),
  ].join("\n");
}

export function daemonStatusCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const status = yield* daemonStatusSnapshot();
    const owner = yield* Effect.promise(() =>
      probeDaemonOwner(DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT, STATUS_PROBE_MS),
    );
    const running = owner === getJazzInstanceId();
    const { spendToday, dailyCaps } = status;
    const cost =
      spendToday.costUSD !== undefined
        ? `$${spendToday.costUSD.toFixed(2)}${dailyCaps.costUSD !== undefined ? ` of $${dailyCaps.costUSD.toFixed(2)}` : ""}`
        : "cost unknown";
    const tokens = `${formatCompactCount(spendToday.totalTokens)}${dailyCaps.tokens !== undefined ? ` of ${formatCompactCount(dailyCaps.tokens)}` : ""} tokens`;
    const lines = [
      `Daemon: ${running ? `running on ${DEFAULT_DAEMON_HOST}:${String(DEFAULT_DAEMON_PORT)}` : owner !== undefined ? `port ${String(DEFAULT_DAEMON_PORT)} is serving another Jazz home` : "not running (jazz daemon starts it)"}`,
      `Background work: ${status.pauseReason ?? "running"}`,
      `Today: ${String(spendToday.runs)} unattended ${spendToday.runs === 1 ? "run" : "runs"} · ${tokens} · ${cost}`,
      "",
      status.waiting.length === 0
        ? "Nothing is waiting for you."
        : `Waiting for you (${String(status.waiting.length)}):\n${status.waiting.map(describeItem).join("\n")}`,
    ];
    emitEnvelope(options.json, { ok: true, running, ...status }, lines.join("\n"));
  }).pipe(stores);
}

export function pauseDaemonCommand(options: { readonly json: boolean }) {
  return pauseDaemon().pipe(
    Effect.map(() =>
      emitEnvelope(
        options.json,
        { ok: true, paused: true },
        "Background work paused: nothing new starts until `jazz daemon resume`. Runs already going finish, and what waits on you can still be answered.",
      ),
    ),
    Effect.catchAll((error) => Effect.sync(() => failEnvelope(options.json, error.message))),
  );
}

/**
 * Why a Jazz agent may not resume the daemon: resuming after a pause at the daily cap lifts the
 * cap, which is the operator's decision about spend. Pausing grants nothing, so it stays allowed.
 */
export const AGENT_RESUME_REFUSAL =
  "Resuming the daemon is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.";

export function resumeDaemonCommand(options: { readonly json: boolean }) {
  if (isAgentStartedProcess()) {
    return Effect.sync(() => failEnvelope(options.json, AGENT_RESUME_REFUSAL));
  }
  return resumeDaemon().pipe(
    Effect.map((state) =>
      emitEnvelope(
        options.json,
        { ok: true, paused: false },
        state.capLiftedUntil !== undefined && Date.parse(state.capLiftedUntil) > Date.now()
          ? `Background work resumed; the daily cap is lifted until ${new Date(state.capLiftedUntil).toLocaleString()}.`
          : "Background work resumed.",
      ),
    ),
    Effect.catchAll((error) => Effect.sync(() => failEnvelope(options.json, error.message))),
  );
}
