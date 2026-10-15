/**
 * The queue of lessons agents proposed, kept in one hidden file at the memory root.
 *
 * Every function here must run inside `withMemoryWriteLock`. A malformed queue reads as empty
 * for listing but refuses new proposals, so a corrupt file never silently swallows one.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import type {
  LessonProposal,
  LessonProposalInput,
  LessonProposalOutcome,
} from "@jazz/core/interfaces/lesson-proposal";
import { replaceControlCharacters } from "@jazz/core/utils/control-characters";
import { toError } from "@jazz/core/utils/errors";
import { decodeStateFile, encodeStateFile, type StateFileKind } from "@jazz/core/utils/state-file";
import { isValidStorageKey, writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect } from "effect";

const QUEUE_FILENAME = ".pending-lessons.json";

/**
 * Proposals waiting at once. A person reviews these by hand, so past this a new one is refused
 * rather than an old one dropped: an unreviewed lesson is never discarded without being seen.
 */
export const MAX_PENDING_LESSONS = 20;

/** Bytes of randomness in a proposal id: 6 hex characters, short enough to type. */
const PROPOSAL_ID_BYTES = 3;

const MAX_RULE_CHARS = 500;
const MAX_MISTAKE_CHARS = 500;

interface LessonQueue {
  readonly proposals: readonly LessonProposal[];
}

const EMPTY_QUEUE: LessonQueue = { proposals: [] };

class UnreadableQueue extends Error {
  constructor() {
    super("The pending-lessons file is unreadable; new lessons are paused until it is fixed.");
  }
}

function queuePath(memoryDirectory: string): string {
  return path.join(memoryDirectory, QUEUE_FILENAME);
}

function isProposal(value: unknown): value is LessonProposal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const requiredStrings = [
    "id",
    "subject",
    "rule",
    "mistake",
    "topic",
    "scope",
    "proposedBy",
    "proposedAt",
  ];
  return (
    requiredStrings.every((key) => typeof record[key] === "string") &&
    (record["conversationId"] === undefined || typeof record["conversationId"] === "string")
  );
}

const LESSON_QUEUE_KIND: StateFileKind<LessonQueue> = {
  noun: "pending lessons",
  schemaVersion: 1,
  parse: (document) => {
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return { ok: false, error: "expected a pending-lessons record" };
    }
    const proposals = (document as Record<string, unknown>)["proposals"];
    if (!Array.isArray(proposals) || !proposals.every(isProposal)) {
      return { ok: false, error: "expected a list of lesson proposals" };
    }
    return { ok: true, content: { proposals } };
  },
  serialize: (queue) => ({ ...queue }),
};

function readQueue(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
): Effect.Effect<LessonQueue, Error> {
  const file = queuePath(memoryDirectory);
  return Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(Effect.mapError(toError));
    if (!exists) {
      return EMPTY_QUEUE;
    }
    const raw = yield* fs.readFileString(file).pipe(Effect.mapError(toError));
    const decoded = decodeStateFile(raw, file, LESSON_QUEUE_KIND);
    return decoded.status === "ok" ? decoded.content : yield* Effect.fail(new UnreadableQueue());
  });
}

function writeQueue(memoryDirectory: string, queue: LessonQueue): Effect.Effect<void, Error> {
  return writeFileStringAtomic(
    queuePath(memoryDirectory),
    encodeStateFile(LESSON_QUEUE_KIND, queue),
  );
}

/** Lowercased words only, so a reworded duplicate of the same rule is still recognized. */
function normalizedRule(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Every waiting proposal, oldest first. An unreadable queue lists as empty. */
export function listLessonProposals(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
): Effect.Effect<readonly LessonProposal[], Error> {
  return readQueue(fs, memoryDirectory).pipe(
    Effect.map((queue) => queue.proposals),
    Effect.catchIf(
      (error) => error instanceof UnreadableQueue,
      () => Effect.succeed([] as readonly LessonProposal[]),
    ),
  );
}

export function addLessonProposal(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  input: LessonProposalInput,
): Effect.Effect<LessonProposalOutcome, Error> {
  return Effect.gen(function* () {
    const rule = replaceControlCharacters(input.rule, " ").trim();
    const mistake = replaceControlCharacters(input.mistake, " ").trim();
    if (!isValidStorageKey(input.scope)) {
      return { success: false, message: `Invalid memory scope name "${input.scope}".` };
    }
    if (rule.length === 0 || rule.length > MAX_RULE_CHARS) {
      return { success: false, message: `A lesson's rule must be 1–${MAX_RULE_CHARS} characters.` };
    }
    if (mistake.length === 0 || mistake.length > MAX_MISTAKE_CHARS) {
      return {
        success: false,
        message: `A lesson's mistake must be 1–${MAX_MISTAKE_CHARS} characters.`,
      };
    }
    const queue = yield* readQueue(fs, memoryDirectory);
    const duplicate = queue.proposals.find(
      (proposal) => normalizedRule(proposal.rule) === normalizedRule(rule),
    );
    if (duplicate !== undefined) {
      return {
        success: true,
        message: "This lesson is already waiting for review.",
        proposal: duplicate,
      };
    }
    if (queue.proposals.length >= MAX_PENDING_LESSONS) {
      return {
        success: false,
        message: `${MAX_PENDING_LESSONS} lessons are already waiting for review; this one was not added.`,
      };
    }
    const proposal: LessonProposal = {
      ...input,
      rule,
      mistake,
      id: randomBytes(PROPOSAL_ID_BYTES).toString("hex"),
      proposedAt: new Date().toISOString(),
    };
    yield* writeQueue(memoryDirectory, { proposals: [...queue.proposals, proposal] });
    return {
      success: true,
      message: "Lesson proposed; it waits for the user to review.",
      proposal,
    };
  });
}

export function findLessonProposal(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  id: string,
): Effect.Effect<LessonProposal | undefined, Error> {
  return listLessonProposals(fs, memoryDirectory).pipe(
    Effect.map((proposals) => proposals.find((proposal) => proposal.id === id.trim())),
  );
}

/** Remove one proposal; `false` when no proposal has that id. */
export function removeLessonProposal(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  id: string,
): Effect.Effect<boolean, Error> {
  return Effect.gen(function* () {
    const queue = yield* readQueue(fs, memoryDirectory);
    const remaining = queue.proposals.filter((proposal) => proposal.id !== id.trim());
    if (remaining.length === queue.proposals.length) {
      return false;
    }
    yield* writeQueue(memoryDirectory, { proposals: remaining });
    return true;
  });
}

/** The entry an accepted lesson becomes: the rule first, since the first line is what recall shows. */
export function formatAcceptedLesson(proposal: Pick<LessonProposal, "rule" | "mistake">): string {
  return `${proposal.rule}\n\nLearned from: ${proposal.mistake}\n`;
}
