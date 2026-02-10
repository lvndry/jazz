import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";

/**
 * Tracks how many distinct sessions a command has been auto-approved in.
 * After reaching the promotion threshold, the user is offered to persist
 * the command in config so it's auto-approved forever.
 *
 * Uses exponential backoff: first prompt at 3 sessions, then 9, 27, etc.
 */

export interface CommandApprovalRecord {
  /** Number of distinct sessions this command was approved in */
  sessionCount: number;
  /** ID of the last session that incremented the count (dedup) */
  lastSessionId: string;
  /** Current promotion threshold — doubles after each decline */
  nextPromptAt: number;
}

export type CommandApprovals = Record<string, CommandApprovalRecord>;

/** Initial number of sessions before first promotion prompt */
export const INITIAL_PROMOTION_THRESHOLD = 3;

/** Multiplier for next threshold after user declines */
export const BACKOFF_MULTIPLIER = 3;

function getApprovalsPath(): string {
  return path.join(getUserDataDirectory(), "command-approvals.json");
}

export function loadCommandApprovals(): Effect.Effect<CommandApprovals, Error> {
  return Effect.gen(function* () {
    const approvalsPath = getApprovalsPath();

    const content = yield* Effect.tryPromise({
      try: () => fs.readFile(approvalsPath, "utf-8"),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(
      Effect.catchIf(
        (e): e is NodeJS.ErrnoException => e instanceof Error && "code" in e && e.code === "ENOENT",
        () => Effect.succeed(""),
      ),
    );

    if (content === "") return {};

    try {
      const data = JSON.parse(content) as CommandApprovals;
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  });
}

export function saveCommandApprovals(data: CommandApprovals): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const approvalsPath = getApprovalsPath();
    const dir = path.dirname(approvalsPath);
    const tempPath = path.join(
      dir,
      `.command-approvals-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: true }));
    yield* Effect.tryPromise(() => fs.writeFile(tempPath, JSON.stringify(data, null, 2)));
    yield* Effect.tryPromise(() => fs.rename(tempPath, approvalsPath)).pipe(
      Effect.tapError(() =>
        Effect.tryPromise(() => fs.unlink(tempPath)).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );
  });
}

/**
 * Record that a command was approved in the given session.
 * Increments sessionCount only if lastSessionId differs (once per session).
 * Returns the new session count.
 */
export function recordCommandApproval(
  command: string,
  sessionId: string,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const approvals = yield* loadCommandApprovals();

    const existing = approvals[command];
    if (existing && existing.lastSessionId === sessionId) {
      // Already counted for this session
      return existing.sessionCount;
    }

    const sessionCount = (existing?.sessionCount ?? 0) + 1;
    const nextPromptAt = existing?.nextPromptAt ?? INITIAL_PROMOTION_THRESHOLD;

    approvals[command] = {
      sessionCount,
      lastSessionId: sessionId,
      nextPromptAt,
    };

    yield* saveCommandApprovals(approvals);
    return sessionCount;
  });
}

/**
 * Remove a command's tracking entry (after promotion to persistent config).
 */
export function removeCommandApproval(command: string): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const approvals = yield* loadCommandApprovals();
    delete approvals[command];
    yield* saveCommandApprovals(approvals);
  });
}

/**
 * Bump the next prompt threshold for a command (user declined promotion).
 * Uses exponential backoff: nextPromptAt = current sessionCount + (currentThreshold * BACKOFF_MULTIPLIER).
 */
export function bumpPromotionThreshold(command: string): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const approvals = yield* loadCommandApprovals();
    const existing = approvals[command];
    if (!existing) return;

    const currentThreshold = existing.nextPromptAt;
    approvals[command] = {
      ...existing,
      nextPromptAt: existing.sessionCount + currentThreshold * BACKOFF_MULTIPLIER,
    };

    yield* saveCommandApprovals(approvals);
  });
}
