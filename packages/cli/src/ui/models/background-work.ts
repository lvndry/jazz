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
  /** How far along it is (`3 of 8 done · 1 failed`); empty before anything has finished. */
  readonly progress: string;
  /** The command a running job is on now, so a row says what it is doing. */
  readonly current?: string;
  /** The end of the first failed job's output, so a row says why. */
  readonly failure?: string;
}

/** Longest failure excerpt a row carries; the full output stays in the batch record. */
const FAILURE_EXCERPT_MAX_LENGTH = 80;

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines[lines.length - 1] ?? "";
  return line.length > FAILURE_EXCERPT_MAX_LENGTH
    ? `${line.slice(0, FAILURE_EXCERPT_MAX_LENGTH - 1)}…`
    : line;
}

/** `check 12 · exit 1 · in_progress` from the newest check the worker saved; empty before one. */
function watchProgress(batch: JobBatchRecord): string {
  const progress = batch.jobs.find((job) => job.poll !== undefined)?.progress;
  if (progress === undefined) {
    return "";
  }
  const parts = [`check ${String(progress.checks)}`, `exit ${String(progress.lastExitCode)}`];
  if (progress.lastOutput.length > 0) {
    parts.push(progress.lastOutput);
  }
  return parts.join(" · ");
}

function jobProgress(
  batch: JobBatchRecord,
): Pick<BackgroundItem, "progress" | "current" | "failure"> {
  const total = batch.jobs.length;
  const done = batch.jobs.filter((job) => job.status === "succeeded").length;
  const failedJobs = batch.jobs.filter((job) => job.status === "failed");
  const running = batch.jobs.find((job) => job.status === "running");
  const parts: string[] = [];
  if (total > 1 || done > 0 || failedJobs.length > 0) {
    parts.push(`${String(done)} of ${String(total)} done`);
  }
  if (failedJobs.length > 0) {
    parts.push(`${String(failedJobs.length)} failed`);
  }
  const failedJob = failedJobs[0];
  const failureText =
    failedJob === undefined
      ? ""
      : lastLine(failedJob.result?.stderr ?? "") ||
        lastLine(failedJob.result?.stdout ?? "") ||
        failedJob.lastError ||
        "";
  return {
    progress: parts.join(" · "),
    ...(running === undefined ? {} : { current: running.command }),
    ...(failedJob === undefined || failureText.length === 0
      ? {}
      : { failure: `exit ${String(failedJob.result?.exitCode ?? "?")}: ${failureText}` }),
  };
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
      ...(poll === undefined ? jobProgress(batch) : { progress: watchProgress(batch) }),
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
    left.every(
      (item, index) =>
        item.batchId === right[index]?.batchId &&
        item.progress === right[index]?.progress &&
        item.current === right[index]?.current &&
        item.failure === right[index]?.failure,
    )
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

/** What a watch re-runs and how often; a job's command. */
export function describeBackgroundCommand(item: BackgroundItem): string {
  return item.intervalMs === undefined
    ? item.command
    : `every ${formatElapsed(item.intervalMs)}: ${item.command}`;
}

/**
 * A row's detail: the newest check of a watch (its command until one has run), or how far a
 * batch of jobs has got and what failed.
 */
export function describeBackgroundCheck(item: BackgroundItem): string {
  if (item.intervalMs !== undefined) {
    return item.progress.length > 0 ? item.progress : describeBackgroundCommand(item);
  }
  const parts = [item.progress];
  if (item.current !== undefined) {
    parts.push(item.current);
  }
  if (item.failure !== undefined) {
    parts.push(item.failure);
  }
  const text = parts.filter((part) => part.length > 0).join(" · ");
  return text.length > 0 ? text : item.command;
}
