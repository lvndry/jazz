import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import { toError } from "@jazz/core/utils/errors";
import { getUserDataDirectory } from "@jazz/core/utils/paths";
import { decodeStateFile, encodeStateFile, type StateFileKind } from "@jazz/core/utils/state-file";
import { writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect } from "effect";

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

/**
 * On-disk shape of the approvals file: the record stamped with a `schemaVersion` so a future
 * format change can migrate instead of guessing. A file written before versioning is a bare
 * record, which `parse` reads unchanged; the next write stores it stamped.
 */
const COMMAND_APPROVALS_KIND: StateFileKind<CommandApprovals> = {
  noun: "command approvals",
  schemaVersion: 1,
  parse: (document) => {
    const { schemaVersion: _schemaVersion, ...data } = document as Record<string, unknown>;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { ok: false, error: "expected a command approvals record" };
    }
    return { ok: true, content: data as unknown as CommandApprovals };
  },
  serialize: (data) => ({ ...data }),
};

/** Initial number of sessions before first promotion prompt */
export const INITIAL_PROMOTION_THRESHOLD = 3;

/** Multiplier for next threshold after user declines */
export const BACKOFF_MULTIPLIER = 3;

function getApprovalsPath(): string {
  return path.join(getUserDataDirectory(), "command-approvals.json");
}

export function loadCommandApprovals(): Effect.Effect<
  CommandApprovals,
  Error,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const approvalsPath = getApprovalsPath();

    const content = yield* fs
      .readFileString(approvalsPath)
      .pipe(
        Effect.catchAll((e) =>
          e &&
          typeof e === "object" &&
          "_tag" in e &&
          (e as { _tag: string })._tag === "SystemError" &&
          (e as { reason?: string }).reason === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(toError(e)),
        ),
      );

    if (content === "") return {};

    const decoded = decodeStateFile(content, "command-approvals.json", COMMAND_APPROVALS_KIND);
    return decoded.status === "ok" ? decoded.content : {};
  });
}

export function saveCommandApprovals(
  data: CommandApprovals,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
  return writeFileStringAtomic(getApprovalsPath(), encodeStateFile(COMMAND_APPROVALS_KIND, data));
}

/**
 * Record that a command was approved in the given session.
 * Increments sessionCount only if lastSessionId differs (once per session).
 * Returns the new session count.
 */
export function recordCommandApproval(
  command: string,
  conversationId: string,
): Effect.Effect<number, Error, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const approvals = yield* loadCommandApprovals();

    const existing = approvals[command];
    if (existing && existing.lastSessionId === conversationId) {
      // Already counted for this session
      return existing.sessionCount;
    }

    const sessionCount = (existing?.sessionCount ?? 0) + 1;
    const nextPromptAt = existing?.nextPromptAt ?? INITIAL_PROMOTION_THRESHOLD;

    approvals[command] = {
      sessionCount,
      lastSessionId: conversationId,
      nextPromptAt,
    };

    yield* saveCommandApprovals(approvals);
    return sessionCount;
  });
}

/**
 * Remove a command's tracking entry (after promotion to persistent config).
 */
export function removeCommandApproval(
  command: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
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
export function bumpPromotionThreshold(
  command: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
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
