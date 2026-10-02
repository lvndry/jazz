/**
 * What the session is still doing after the turn ended: waits that poll a condition and other
 * queued jobs. Every surface that shows them (both footers, the list under the composer, the
 * `/waits` command) reads the same items, so a wait is never described two ways.
 */

import type { JobBatchRecord } from "@jazz/core/interfaces/job-queue-service";
import { formatElapsed } from "../text/format";

export type BackgroundItemKind = "watch" | "job";

export interface BackgroundItem {
  readonly batchId: string;
  readonly kind: BackgroundItemKind;
  /** The agent's stated reason for the batch; the command when it gave none. */
  readonly description: string;
  readonly command: string;
  /** Epoch ms the batch was queued. */
  readonly startedAt: number;
  /** Watches only: ms between checks. */
  readonly intervalMs?: number;
  /** Watches only: epoch ms after which the wait gives up. */
  readonly expiresAt?: number;
}

export interface BackgroundWork {
  readonly watching: number;
  readonly jobs: number;
}

/** This conversation's unfinished batches, oldest first; a batch whose jobs poll is a watch. */
export function backgroundItems(
  batches: readonly JobBatchRecord[],
  conversationId: string,
): readonly BackgroundItem[] {
  const items: BackgroundItem[] = [];
  for (const batch of batches) {
    if (batch.conversationId !== conversationId || batch.completedAt !== null) {
      continue;
    }
    const firstJob = batch.jobs[0];
    const poll = batch.jobs.find((job) => job.poll !== undefined)?.poll;
    const command = firstJob?.command ?? "";
    items.push({
      batchId: batch.id,
      kind: poll === undefined ? "job" : "watch",
      description: batch.reason.length > 0 ? batch.reason : command,
      command,
      startedAt: batch.createdAt,
      ...(poll === undefined
        ? {}
        : { intervalMs: poll.intervalMs, expiresAt: batch.createdAt + poll.timeoutMs }),
    });
  }
  return items.sort((left, right) => left.startedAt - right.startedAt);
}

export function sameBackgroundItems(
  left: readonly BackgroundItem[],
  right: readonly BackgroundItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item.batchId === right[index]?.batchId)
  );
}

export function countBackgroundWork(items: readonly BackgroundItem[]): BackgroundWork {
  const watching = items.filter((item) => item.kind === "watch").length;
  return { watching, jobs: items.length - watching };
}

/** `watching 2`, `1 job running`, or both joined by the caller's separator; undefined when idle. */
export function formatBackgroundWork(
  items: readonly BackgroundItem[],
  separator = " · ",
): string | undefined {
  const work = countBackgroundWork(items);
  const parts: string[] = [];
  if (work.watching > 0) {
    parts.push(`watching ${String(work.watching)}`);
  }
  if (work.jobs > 0) {
    parts.push(`${String(work.jobs)} ${work.jobs === 1 ? "job" : "jobs"} running`);
  }
  return parts.length === 0 ? undefined : parts.join(separator);
}

/** How long a watch has left before it gives up (`gives up in 4m 12s`); a job shows its age. */
export function describeBackgroundTiming(item: BackgroundItem, now: number): string {
  if (item.expiresAt !== undefined) {
    return `gives up in ${formatElapsed(Math.max(0, item.expiresAt - now))}`;
  }
  return `running ${formatElapsed(Math.max(0, now - item.startedAt))}`;
}

/** The interval and command a watch re-runs, for a row's second line. */
export function describeBackgroundCheck(item: BackgroundItem): string {
  if (item.intervalMs === undefined) {
    return item.command;
  }
  return `every ${formatElapsed(item.intervalMs)}: ${item.command}`;
}
