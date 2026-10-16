/**
 * The queue of memory suggestions — fact writes and lessons — kept in one hidden file at the
 * memory root, waiting for the person to keep or ignore them.
 *
 * Every function here must run inside `withMemoryWriteLock`. A malformed queue reads as empty
 * for listing but refuses new suggestions, so a corrupt file never silently swallows one.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { FileSystem } from "@effect/platform";
import type {
  FactSuggestion,
  FactSuggestionInput,
  LessonProposal,
  LessonProposalInput,
  MemorySuggestion,
  MemorySuggestionOutcome,
} from "@jazz/core/interfaces/memory-suggestion";
import { replaceControlCharacters } from "@jazz/core/utils/control-characters";
import { toError } from "@jazz/core/utils/errors";
import { decodeStateFile, encodeStateFile, type StateFileKind } from "@jazz/core/utils/state-file";
import { isValidStorageKey, writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect } from "effect";

const QUEUE_FILENAME = ".pending-memory.json";

/**
 * Suggestions waiting at once. A person reviews these by hand, so past this a new one is refused
 * rather than an old one dropped: an unreviewed suggestion is never discarded without being seen.
 * Sized for several compaction passes between reviews, each of which can queue up to six facts
 * and three lessons.
 */
export const MAX_PENDING_SUGGESTIONS = 40;

/** Bytes of randomness in a suggestion id: 6 hex characters, short enough to type. */
const SUGGESTION_ID_BYTES = 3;

const MAX_RULE_CHARS = 500;
const MAX_MISTAKE_CHARS = 500;

interface SuggestionQueue {
  readonly suggestions: readonly MemorySuggestion[];
}

const EMPTY_QUEUE: SuggestionQueue = { suggestions: [] };

class UnreadableQueue extends Error {
  constructor() {
    super("The pending-memory file is unreadable; new suggestions are paused until it is fixed.");
  }
}

function queuePath(memoryDirectory: string): string {
  return path.join(memoryDirectory, QUEUE_FILENAME);
}

function hasStrings(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof record[key] === "string");
}

function isChange(value: unknown): value is FactSuggestion["change"] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record["command"] === "create") {
    return hasStrings(record, ["path", "content"]);
  }
  if (record["command"] === "amend") {
    return hasStrings(record, ["path", "previousContent", "content"]);
  }
  return false;
}

function isSuggestion(value: unknown): value is MemorySuggestion {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasStrings(record, ["id", "proposedBy", "proposedAt"]) ||
    (record["conversationId"] !== undefined && typeof record["conversationId"] !== "string")
  ) {
    return false;
  }
  if (record["kind"] === "lesson") {
    return hasStrings(record, ["subject", "rule", "mistake", "topic", "scope"]);
  }
  if (record["kind"] === "fact") {
    const keys = record["quotedSentenceKeys"];
    return (
      typeof record["quote"] === "string" &&
      Array.isArray(keys) &&
      keys.every((key) => typeof key === "string") &&
      isChange(record["change"])
    );
  }
  return false;
}

const SUGGESTION_QUEUE_KIND: StateFileKind<SuggestionQueue> = {
  noun: "pending memory suggestions",
  schemaVersion: 1,
  parse: (document) => {
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return { ok: false, error: "expected a pending-memory record" };
    }
    const suggestions = (document as Record<string, unknown>)["suggestions"];
    if (!Array.isArray(suggestions) || !suggestions.every(isSuggestion)) {
      return { ok: false, error: "expected a list of memory suggestions" };
    }
    return { ok: true, content: { suggestions } };
  },
  serialize: (queue) => ({ ...queue }),
};

function readQueue(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
): Effect.Effect<SuggestionQueue, Error> {
  const file = queuePath(memoryDirectory);
  return Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(Effect.mapError(toError));
    if (!exists) {
      return EMPTY_QUEUE;
    }
    const raw = yield* fs.readFileString(file).pipe(Effect.mapError(toError));
    const decoded = decodeStateFile(raw, file, SUGGESTION_QUEUE_KIND);
    return decoded.status === "ok" ? decoded.content : yield* Effect.fail(new UnreadableQueue());
  });
}

function writeQueue(memoryDirectory: string, queue: SuggestionQueue): Effect.Effect<void, Error> {
  return writeFileStringAtomic(
    queuePath(memoryDirectory),
    encodeStateFile(SUGGESTION_QUEUE_KIND, queue),
  );
}

/** Lowercased words only, so a reworded duplicate is still recognized. */
function normalizedWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isSameSuggestion(waiting: MemorySuggestion, candidate: MemorySuggestion): boolean {
  if (waiting.kind === "lesson" && candidate.kind === "lesson") {
    return normalizedWords(waiting.rule) === normalizedWords(candidate.rule);
  }
  if (waiting.kind === "fact" && candidate.kind === "fact") {
    return (
      waiting.change.path === candidate.change.path &&
      normalizedWords(waiting.change.content) === normalizedWords(candidate.change.content)
    );
  }
  return false;
}

function enqueue<Suggestion extends MemorySuggestion>(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  suggestion: Suggestion,
): Effect.Effect<MemorySuggestionOutcome<Suggestion>, Error> {
  return Effect.gen(function* () {
    const queue = yield* readQueue(fs, memoryDirectory);
    const duplicate = queue.suggestions.find((waiting) => isSameSuggestion(waiting, suggestion));
    if (duplicate !== undefined) {
      return {
        success: true,
        message: "This is already waiting for review.",
        suggestion: duplicate as Suggestion,
      };
    }
    if (queue.suggestions.length >= MAX_PENDING_SUGGESTIONS) {
      return {
        success: false,
        message: `${MAX_PENDING_SUGGESTIONS} memory suggestions are already waiting for review; this one was not added.`,
      };
    }
    yield* writeQueue(memoryDirectory, { suggestions: [...queue.suggestions, suggestion] });
    return {
      success: true,
      message:
        suggestion.kind === "lesson"
          ? "Lesson proposed; it waits for the user to review."
          : "Suggested; it waits for the user to review.",
      suggestion,
    };
  });
}

function queuedFields(): { id: string; proposedAt: string } {
  return {
    id: randomBytes(SUGGESTION_ID_BYTES).toString("hex"),
    proposedAt: new Date().toISOString(),
  };
}

/** Every waiting suggestion, oldest first. An unreadable queue lists as empty. */
export function listMemorySuggestions(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
): Effect.Effect<readonly MemorySuggestion[], Error> {
  return readQueue(fs, memoryDirectory).pipe(
    Effect.map((queue) => queue.suggestions),
    Effect.catchIf(
      (error) => error instanceof UnreadableQueue,
      () => Effect.succeed([] as readonly MemorySuggestion[]),
    ),
  );
}

export function addLessonProposal(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  input: LessonProposalInput,
): Effect.Effect<MemorySuggestionOutcome<LessonProposal>, Error> {
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
    return yield* enqueue(fs, memoryDirectory, {
      ...input,
      rule,
      mistake,
      kind: "lesson",
      ...queuedFields(),
    } satisfies LessonProposal);
  });
}

export function addFactSuggestion(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  input: FactSuggestionInput,
): Effect.Effect<MemorySuggestionOutcome<FactSuggestion>, Error> {
  return enqueue(fs, memoryDirectory, {
    ...input,
    kind: "fact",
    ...queuedFields(),
  } satisfies FactSuggestion);
}

export function findMemorySuggestion(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  id: string,
): Effect.Effect<MemorySuggestion | undefined, Error> {
  return listMemorySuggestions(fs, memoryDirectory).pipe(
    Effect.map((suggestions) => suggestions.find((suggestion) => suggestion.id === id.trim())),
  );
}

/** Remove one suggestion; `false` when none has that id. */
export function removeMemorySuggestion(
  fs: FileSystem.FileSystem,
  memoryDirectory: string,
  id: string,
): Effect.Effect<boolean, Error> {
  return Effect.gen(function* () {
    const queue = yield* readQueue(fs, memoryDirectory);
    const remaining = queue.suggestions.filter((suggestion) => suggestion.id !== id.trim());
    if (remaining.length === queue.suggestions.length) {
      return false;
    }
    yield* writeQueue(memoryDirectory, { suggestions: remaining });
    return true;
  });
}

/** The entry an accepted lesson becomes: the rule first, since the first line is what recall shows. */
export function formatAcceptedLesson(proposal: Pick<LessonProposal, "rule" | "mistake">): string {
  return `${proposal.rule}\n\nLearned from: ${proposal.mistake}\n`;
}
