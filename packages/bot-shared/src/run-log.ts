/**
 * @fileoverview Per-turn NDJSON record of what a bridge run did.
 *
 * The conversation transcript is only written once a run completes, so a run that
 * hangs or times out leaves no other trace. The event stream is already decoded to
 * drive the progress message; recording it costs one append per event and is what
 * makes a stuck run diagnosable without the model server's logs.
 *
 * Appends are fire-and-forget: a logging failure must never interrupt a run, so
 * every error is swallowed after the first, which is reported once.
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Events whose payload is bulky and already summarised by other lines. */
const OMITTED_FIELDS = ["accumulated", "previewDiff"] as const;

/**
 * Deltas arrive one per token-ish chunk, thousands to a long generation. Written
 * individually they dominate the file for no diagnostic gain: a reader needs when
 * the stream started, how much came out and how long it took. Counted and flushed
 * as one line.
 */
const COALESCED_TYPES = new Set(["thinking_chunk", "text_chunk"]);

/** Run logs to keep per bridge; older ones are removed as new runs start. */
const RUNS_RETAINED = 200;

/**
 * How long a run of deltas may stay buffered before it is written anyway.
 *
 * The next event would otherwise be the only thing that flushes them, which loses
 * the tail of any run that stalls mid-stream — the case this log exists for. Two
 * seconds keeps a healthy run to a handful of lines while making a stall visible
 * within one.
 */
const FLUSH_INTERVAL_MS = 2_000;

export interface RunLog {
  /** Record one event from the jazz stream. */
  event: (event: object) => void;
  /**
   * Record the run's outcome, including a timeout or crash. Also releases the
   * flush timer, so this must be called exactly once per run.
   */
  finish: (outcome: object) => void;
  /** Path written to, for a bridge that wants to mention it. */
  readonly path: string;
}

/** A no-op log, so callers never branch on whether logging is enabled. */
export function nullRunLog(): RunLog {
  return { event: () => {}, finish: () => {}, path: "" };
}

/**
 * Drop the oldest logs beyond the retention count. Names are timestamped, so a
 * lexical sort is chronological and no file needs to be stat-ed.
 */
function pruneOldRuns(directory: string): void {
  try {
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".ndjson"))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - RUNS_RETAINED))) {
      rmSync(join(directory, name), { force: true });
    }
  } catch {
    // Retention is housekeeping; failing to prune must not fail a run.
  }
}

/**
 * Open a run log under `<dataDir>/logs/runs/`. The name carries the
 * conversation and the start time so a chat's turns sort chronologically and
 * two concurrent runs in the same chat cannot collide.
 */
export function createRunLog(
  dataDir: string,
  conversationKey: string,
  startedAt: Date = new Date(),
): RunLog {
  const directory = join(dataDir, "logs", "runs");
  // Colons are legal on the filesystems this runs on but awkward to type in a
  // shell, and this path exists to be opened by a human in a hurry.
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const safeKey = conversationKey.replace(/[^A-Za-z0-9_-]/g, "_");
  const path = join(directory, `${safeKey}-${stamp}.ndjson`);

  let broken = false;
  const append = (record: Record<string, unknown>): void => {
    if (broken) return;
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch (error) {
      broken = true;
      console.error(`Run log ${path} disabled after write failure: ${String(error)}`);
    }
  };

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    console.error(`Run log directory ${directory} unavailable: ${String(error)}`);
    return nullRunLog();
  }

  pruneOldRuns(directory);

  const startedMs = startedAt.getTime();
  append({ at: startedAt.toISOString(), elapsedMs: 0, type: "run_start", conversationKey });

  // The run of deltas currently being counted, flushed when anything else
  // happens so the file keeps the order the events arrived in.
  let pending: { type: string; chunks: number; characters: number; firstMs: number } | undefined;

  const now = (): Record<string, unknown> => ({
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedMs,
  });

  const flush = (): void => {
    if (pending === undefined) return;
    const { type, chunks, characters, firstMs } = pending;
    pending = undefined;
    append({
      ...now(),
      type,
      chunks,
      characters,
      // How long the model spent streaming this run of deltas, which is the
      // number that tells a slow round apart from a long one.
      streamedMs: Date.now() - firstMs,
    });
  };

  // Unref'd so a bridge process is never held open by a log, and cleared in
  // finish() so a long-lived bridge does not accumulate one timer per turn.
  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();

  return {
    path,
    event: (rawEvent) => {
      const event = rawEvent as Record<string, unknown>;
      const type = typeof event["type"] === "string" ? event["type"] : "unknown";
      if (COALESCED_TYPES.has(type)) {
        const delta = event["content"] ?? event["delta"];
        const length = typeof delta === "string" ? delta.length : 0;
        if (pending?.type === type) {
          pending.chunks += 1;
          pending.characters += length;
        } else {
          flush();
          pending = { type, chunks: 1, characters: length, firstMs: Date.now() };
        }
        return;
      }
      flush();
      const record: Record<string, unknown> = now();
      for (const [key, value] of Object.entries(event)) {
        if ((OMITTED_FIELDS as readonly string[]).includes(key)) continue;
        record[key] = value;
      }
      append(record);
    },
    finish: (outcome) => {
      clearInterval(flushTimer);
      flush();
      append({ ...now(), type: "run_finish", ...outcome });
    },
  };
}
