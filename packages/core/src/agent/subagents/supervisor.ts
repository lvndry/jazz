/**
 * The sub-agents of one run: what `spawn_subagent`, `list_subagents`, `wait_subagents` and
 * `steer_subagent` act on.
 *
 * Every child of a run is registered here, the ones the parent waits on and the ones it starts in
 * the background. Background children run as fibers in a scope owned by the parent's run, so they
 * never outlive it: closing the supervisor when the run ends, however it ends, cancels whatever is
 * still going, along with the tools and processes those children started.
 *
 * Steering takes effect at a child's step boundary, before its next model call: a message is
 * delivered there, and a pause holds the child there without any model call until it is resumed.
 * Cancelling interrupts the child at once.
 *
 * Money is one pool. Each child reports what it has spent after every step, and the parent's cost
 * cap counts that live spend, so parallel children cannot each spend the whole remainder.
 */

import { Deferred, Duration, Effect, Exit, Fiber, Scope } from "effect";
import type { ToolExecutionResult, ToolProgressEvent } from "@/core/types/tools";

/** Background children one run may have going at once. Matches `JAZZ_BOT_MAX_CONCURRENT_RUNS`. */
export const MAX_LIVE_SUBAGENTS = 4;

export type SubagentStatus =
  "running" | "paused" | "waiting-approval" | "completed" | "failed" | "cancelled";

/** What the parent sees of one child. */
export interface SubagentSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: SubagentStatus;
  readonly background: boolean;
  readonly elapsedMs: number;
  /** The tool the child last started, while it is still working. */
  readonly lastActivity?: string;
  /** What it has spent so far, while it runs. Its final cost is charged to the parent on exit. */
  readonly liveCostUSD?: number;
  /** Its answer, once it finished. */
  readonly result?: unknown;
  readonly error?: string;
  /** Messages from the parent it finished before reading: that guidance never reached it. */
  readonly undeliveredMessages?: readonly string[];
}

export type SteerAction = "message" | "pause" | "resume" | "cancel";

export type SteerOutcome =
  | { readonly ok: true; readonly status: SubagentStatus; readonly note: string }
  | { readonly ok: false; readonly error: string };

export type WaitUntil = "any" | "all";

/** The hooks a child's run uses to take steering and report on itself. */
export interface SubagentHooks {
  readonly id: string;
  /** A message from the parent waiting for the child's next step. */
  readonly takeParentMessage: () => string | undefined;
  /** Holds the child at its step boundary while it is paused. */
  readonly beforeStep: () => Effect.Effect<void>;
  /** Whether the parent asked the child to pause at its next step. */
  readonly pauseRequested: () => boolean;
  /** The child's spend so far, reported after each of its steps. */
  readonly reportSpend: (costUSD: number | undefined) => void;
  readonly onToolEvent: (event: ToolProgressEvent) => void;
}

interface Entry {
  readonly id: string;
  readonly name: string;
  readonly background: boolean;
  readonly startedAt: number;
  status: SubagentStatus;
  lastActivity: string | undefined;
  liveCostUSD: number;
  readonly mailbox: string[];
  pauseRequested: boolean;
  resumeGate: Deferred.Deferred<void> | undefined;
  fiber: Fiber.RuntimeFiber<void> | undefined;
  result: ToolExecutionResult | undefined;
  finishedAt: number | undefined;
  /** The parent has read this child's result through `wait_subagents`. */
  collected: boolean;
  /** The parent was told it finished. */
  announced: boolean;
  /** The parent was asked to read its result before answering. */
  offeredAtAnswer: boolean;
  /** Why it is being cancelled, for the result the parent reads. */
  cancelReason: string | undefined;
}

const FINISHED: ReadonlySet<SubagentStatus> = new Set(["completed", "failed", "cancelled"]);

export interface SubagentSupervisor {
  /** Background children still running, paused or waiting on approval. */
  readonly liveCount: () => number;
  /** Register a child about to start; its hooks go into the child's run. */
  readonly register: (input: {
    readonly name: string;
    readonly background: boolean;
  }) => SubagentHooks;
  /** Record how a child the parent waited on ended. */
  readonly finish: (id: string, result: ToolExecutionResult, cancelled?: boolean) => void;
  /** Run a background child in the supervisor's scope. */
  readonly startInBackground: <R>(
    id: string,
    work: Effect.Effect<ToolExecutionResult, never, R>,
  ) => Effect.Effect<void, never, R>;
  readonly list: () => readonly SubagentSnapshot[];
  /**
   * Wait until the children named (every background child when `ids` is empty) have finished or
   * need attention: `any` returns once one of them has, `all` once none is still running. Their
   * results are marked read.
   */
  readonly wait: (
    ids: readonly string[],
    until: WaitUntil,
    timeoutMs: number,
  ) => Effect.Effect<{
    readonly subagents: readonly SubagentSnapshot[];
    readonly timedOut: boolean;
  }>;
  readonly steer: (
    id: string,
    action: SteerAction,
    message?: string,
  ) => Effect.Effect<SteerOutcome>;
  /** One-line notices for the parent's next step: children that finished since it last looked. */
  readonly takeNotices: () => readonly string[];
  /**
   * Called when the parent answers. Cancels paused children, waits for running ones, and returns
   * the notice to give the parent when some finished work was never read; undefined when there
   * is nothing to read, so the answer can stand.
   */
  readonly settleBeforeAnswer: () => Effect.Effect<string | undefined>;
  /** What children still running have spent, not yet charged to the parent. */
  readonly liveCostUSD: () => number;
  /** Whether the run's cost cap is used up, counting live child spend. */
  readonly costExhausted: () => boolean;
  /** Tell the supervisor the run's cost cap and its own spend so far. */
  readonly bindCostCap: (
    maxCostUSD: number | undefined,
    spentUSD: () => number | undefined,
  ) => void;
  /** Cancel every child still going. */
  readonly close: () => Effect.Effect<void>;
}

let subagentSequence = 0;

export function createSubagentSupervisor(): Effect.Effect<SubagentSupervisor> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entries = new Map<string, Entry>();
    let changed = yield* Deferred.make<void>();
    let maxCostUSD: number | undefined;
    let spentUSD: () => number | undefined = () => undefined;

    const signalChange = Effect.gen(function* () {
      const previous = changed;
      changed = yield* Deferred.make<void>();
      yield* Deferred.succeed(previous, undefined);
    });
    const signalChangeSync = () => Effect.runSync(signalChange);

    const snapshot = (entry: Entry): SubagentSnapshot => ({
      id: entry.id,
      name: entry.name,
      status: entry.status,
      background: entry.background,
      elapsedMs: (entry.finishedAt ?? Date.now()) - entry.startedAt,
      ...(entry.lastActivity !== undefined && !FINISHED.has(entry.status)
        ? { lastActivity: entry.lastActivity }
        : {}),
      ...(!FINISHED.has(entry.status) && entry.liveCostUSD > 0
        ? { liveCostUSD: entry.liveCostUSD }
        : {}),
      ...(entry.result !== undefined && entry.result.success
        ? { result: entry.result.result }
        : {}),
      ...(entry.result !== undefined && !entry.result.success
        ? { error: entry.result.error ?? "The sub-agent failed." }
        : {}),
      ...(FINISHED.has(entry.status) && entry.mailbox.length > 0
        ? { undeliveredMessages: [...entry.mailbox] }
        : {}),
    });

    const isLive = (entry: Entry) => entry.background && !FINISHED.has(entry.status);

    const finish = (id: string, result: ToolExecutionResult, cancelled = false) => {
      const entry = entries.get(id);
      if (entry === undefined || FINISHED.has(entry.status)) {
        return;
      }
      entry.result = result;
      entry.status = cancelled ? "cancelled" : result.success ? "completed" : "failed";
      entry.finishedAt = Date.now();
      entry.liveCostUSD = 0;
      entry.fiber = undefined;
      if (entry.resumeGate !== undefined) {
        Effect.runSync(Deferred.succeed(entry.resumeGate, undefined));
        entry.resumeGate = undefined;
      }
      signalChangeSync();
    };

    const liveCostUSD = () => {
      let total = 0;
      for (const entry of entries.values()) {
        if (!FINISHED.has(entry.status)) {
          total += entry.liveCostUSD;
        }
      }
      return total;
    };

    const resolveTargets = (ids: readonly string[]) =>
      ids.length === 0
        ? [...entries.values()].filter((entry) => entry.background)
        : ids.flatMap((id) => {
            const entry = entries.get(id);
            return entry === undefined ? [] : [entry];
          });

    const cancelEntry = (entry: Entry, reason: string) =>
      Effect.gen(function* () {
        entry.cancelReason = reason;
        const fiber = entry.fiber;
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber);
        }
        finish(entry.id, { success: false, result: null, error: reason }, true);
      });

    const supervisor: SubagentSupervisor = {
      liveCount: () => [...entries.values()].filter(isLive).length,

      register: ({ name, background }) => {
        const id = `sa-${String(++subagentSequence)}`;
        const entry: Entry = {
          id,
          name,
          background,
          startedAt: Date.now(),
          status: "running",
          lastActivity: undefined,
          liveCostUSD: 0,
          mailbox: [],
          pauseRequested: false,
          resumeGate: undefined,
          fiber: undefined,
          result: undefined,
          finishedAt: undefined,
          collected: !background,
          announced: !background,
          offeredAtAnswer: !background,
          cancelReason: undefined,
        };
        entries.set(id, entry);
        return {
          id,
          takeParentMessage: () => entry.mailbox.shift(),
          pauseRequested: () => entry.pauseRequested,
          beforeStep: () =>
            Effect.gen(function* () {
              if (!entry.pauseRequested) {
                return;
              }
              const gate = yield* Deferred.make<void>();
              entry.resumeGate = gate;
              entry.status = "paused";
              yield* signalChange;
              yield* Deferred.await(gate);
            }),
          reportSpend: (costUSD) => {
            if (costUSD !== undefined) {
              entry.liveCostUSD = costUSD;
            }
          },
          onToolEvent: (event) => {
            if (FINISHED.has(entry.status)) {
              return;
            }
            if (event.kind === "approval-required") {
              entry.status = "waiting-approval";
              entry.lastActivity = `waiting on approval for ${event.toolName}`;
              signalChangeSync();
              return;
            }
            if (entry.status === "waiting-approval") {
              entry.status = "running";
              signalChangeSync();
            }
            entry.lastActivity = event.toolName;
          },
        };
      },

      finish,

      startInBackground: (id, work) =>
        Effect.gen(function* () {
          const entry = entries.get(id);
          if (entry === undefined) {
            return;
          }
          const fiber = yield* work.pipe(
            Effect.map((result) => finish(id, result)),
            Effect.onInterrupt(() =>
              Effect.sync(() =>
                finish(
                  id,
                  {
                    success: false,
                    result: null,
                    error: entry.cancelReason ?? "Stopped when the parent run ended.",
                  },
                  true,
                ),
              ),
            ),
            Effect.forkIn(scope),
          );
          if (!FINISHED.has(entry.status)) {
            entry.fiber = fiber;
          }
        }),

      list: () => [...entries.values()].map(snapshot),

      wait: (ids, until, timeoutMs) =>
        Effect.gen(function* () {
          const targets = resolveTargets(ids);
          const deadline = Date.now() + timeoutMs;
          const needsParent = (entry: Entry) => entry.status !== "running";
          const satisfied = () =>
            targets.length === 0 ||
            (until === "any" ? targets.some(needsParent) : targets.every(needsParent));
          let timedOut = false;
          while (!satisfied()) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              timedOut = true;
              break;
            }
            yield* Deferred.await(changed).pipe(Effect.timeoutOption(Duration.millis(remaining)));
          }
          for (const entry of targets) {
            if (FINISHED.has(entry.status)) {
              entry.collected = true;
              entry.announced = true;
            }
          }
          return { subagents: targets.map(snapshot), timedOut };
        }),

      steer: (id, action, message) =>
        Effect.gen(function* () {
          const entry = entries.get(id);
          if (entry === undefined) {
            return {
              ok: false,
              error: `No sub-agent ${id} in this run. Sub-agents stop when the run that started them ends.`,
            } as const;
          }
          if (FINISHED.has(entry.status)) {
            return { ok: false, error: `${entry.name} (${id}) already ${entry.status}.` } as const;
          }
          if (!entry.background) {
            return {
              ok: false,
              error: `${entry.name} (${id}) was started without background: true, so this run is waiting on it.`,
            } as const;
          }
          switch (action) {
            case "message": {
              const text = message?.trim() ?? "";
              if (text === "") {
                return { ok: false, error: "A message action needs a message." } as const;
              }
              entry.mailbox.push(text);
              return {
                ok: true,
                status: entry.status,
                note:
                  entry.status === "paused"
                    ? "Queued; it is delivered when you resume the sub-agent."
                    : "Queued; it is delivered before the sub-agent's next model call.",
              } as const;
            }
            case "pause": {
              entry.pauseRequested = true;
              return {
                ok: true,
                status: entry.status,
                note: "It pauses before its next model call and spends nothing while paused.",
              } as const;
            }
            case "resume": {
              entry.pauseRequested = false;
              const gate = entry.resumeGate;
              entry.resumeGate = undefined;
              if (gate !== undefined) {
                entry.status = "running";
                yield* Deferred.succeed(gate, undefined);
                yield* signalChange;
              }
              return { ok: true, status: entry.status, note: "Resumed." } as const;
            }
            case "cancel": {
              yield* cancelEntry(entry, "Cancelled by the parent agent.");
              return { ok: true, status: "cancelled", note: "Cancelled." } as const;
            }
          }
        }),

      takeNotices: () => {
        const notices: string[] = [];
        for (const entry of entries.values()) {
          if (entry.background && FINISHED.has(entry.status) && !entry.announced) {
            entry.announced = true;
            notices.push(
              `Sub-agent ${entry.name} (${entry.id}) ${entry.status}; call wait_subagents to read its result.`,
            );
          }
        }
        return notices;
      },

      settleBeforeAnswer: () =>
        Effect.gen(function* () {
          const background = [...entries.values()].filter((entry) => entry.background);
          const paused = background.filter((entry) => entry.status === "paused");
          for (const entry of paused) {
            yield* cancelEntry(
              entry,
              "Cancelled because the parent answered while this sub-agent was paused.",
            );
          }
          yield* Effect.forEach(
            background.filter(isLive),
            (entry) =>
              entry.fiber === undefined
                ? Effect.void
                : Fiber.await(entry.fiber).pipe(Effect.asVoid),
            { concurrency: "unbounded", discard: true },
          );
          const unread = background.filter(
            (entry) => FINISHED.has(entry.status) && !entry.collected && !entry.offeredAtAnswer,
          );
          if (unread.length === 0) {
            return undefined;
          }
          for (const entry of unread) {
            entry.offeredAtAnswer = true;
            entry.announced = true;
          }
          const names = unread.map((entry) => `${entry.name} (${entry.id})`).join(", ");
          const cancelledNote =
            paused.length > 0
              ? ` ${String(paused.length)} paused sub-agent${paused.length === 1 ? " was" : "s were"} cancelled.`
              : "";
          return `You answered before reading your sub-agents' results: ${names}.${cancelledNote} Call wait_subagents to read them, then give your final answer.`;
        }),

      liveCostUSD,

      costExhausted: () => {
        if (maxCostUSD === undefined) {
          return false;
        }
        return (spentUSD() ?? 0) + liveCostUSD() >= maxCostUSD;
      },

      bindCostCap: (cap, spent) => {
        maxCostUSD = cap;
        spentUSD = spent;
      },

      close: () =>
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void);
          // A child whose fiber was interrupted before it started never ran its own handler.
          for (const entry of entries.values()) {
            if (!FINISHED.has(entry.status)) {
              finish(
                entry.id,
                {
                  success: false,
                  result: null,
                  error: entry.cancelReason ?? "Stopped when the parent run ended.",
                },
                true,
              );
            }
          }
        }),
    };
    return supervisor;
  });
}
