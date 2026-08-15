import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { getWorkStateDirectory } from "@/core/utils/paths";

/**
 * An append-only record of what each compaction summarized away.
 *
 * Compaction already produces a structured summary and then places it in context, where
 * the *next* compaction folds it into the running summary. That is the right thing to do
 * in context, but it means the only copy of an early summary lives inside a document
 * being continuously rewritten. Appending it here first costs no tokens and no LLM call,
 * and gives a record that later cycles cannot degrade.
 *
 * Append-only and one JSON object per line, so a crash mid-write can damage at most the
 * final record rather than the file.
 */

const JOURNAL_FILENAME = "journal.jsonl";

export interface JournalEntry {
  /** ISO-8601. Supplied by the caller so this module stays free of ambient clock reads. */
  readonly recordedAt: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  /** The summary text produced by this compaction. */
  readonly summary: string;
}

export function journalPath(agentId: string, conversationId: string): string {
  return path.join(getWorkStateDirectory(agentId, conversationId), JOURNAL_FILENAME);
}

/**
 * Append one entry. Never throws: losing a journal write must not fail the run it is
 * describing, since the summary itself is already safely in context.
 */
export function appendJournalEntry(
  agentId: string,
  conversationId: string,
  entry: JournalEntry,
): Effect.Effect<boolean, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const directory = getWorkStateDirectory(agentId, conversationId);
      await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
      await nodeFs.appendFile(
        path.join(directory, JOURNAL_FILENAME),
        `${JSON.stringify(entry)}\n`,
        "utf-8",
      );
      return true;
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

/**
 * Read the journal, oldest first. Malformed lines are skipped rather than fatal — a
 * partially written final line should not cost you the entries before it.
 */
export function readJournal(
  agentId: string,
  conversationId: string,
): Effect.Effect<JournalEntry[], never, never> {
  return Effect.tryPromise({
    try: () => nodeFs.readFile(journalPath(agentId, conversationId), "utf-8"),
    catch: (error) => error,
  }).pipe(
    Effect.map((contents) => {
      const entries: JournalEntry[] = [];
      for (const line of contents.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          entries.push(JSON.parse(trimmed) as JournalEntry);
        } catch {
          // Skip a torn or corrupt line; the rest of the file is still good.
        }
      }
      return entries;
    }),
    Effect.catchAll(() => Effect.succeed<JournalEntry[]>([])),
  );
}

/**
 * Ceiling on stored working state per conversation. Journals are summaries, not
 * transcripts, so this is generous in practice — it exists so an agent that compacts
 * hundreds of times cannot fill the disk unnoticed.
 */
export const MAX_WORK_STATE_BYTES_PER_CONVERSATION = 2 * 1024 * 1024;

/** Delete a conversation's working state. Used when a task is finished or abandoned. */
export function clearWorkState(
  agentId: string,
  conversationId: string,
): Effect.Effect<boolean, never, never> {
  return Effect.tryPromise({
    try: async () => {
      await nodeFs.rm(getWorkStateDirectory(agentId, conversationId), {
        recursive: true,
        force: true,
      });
      return true;
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

/** Bytes currently stored for a conversation. Zero when nothing is stored. */
export function workStateSizeBytes(
  agentId: string,
  conversationId: string,
): Effect.Effect<number, never, never> {
  return Effect.tryPromise({
    try: async () => {
      const directory = getWorkStateDirectory(agentId, conversationId);
      const names = await nodeFs.readdir(directory);
      let total = 0;
      for (const name of names) {
        const stats = await nodeFs.stat(path.join(directory, name));
        if (stats.isFile()) total += stats.size;
      }
      return total;
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.succeed(0)));
}

/**
 * Drop the oldest journal entries until the file is back under the cap.
 *
 * Oldest-first because the newest records describe where the task actually is; an old
 * record of finished work is the most expendable thing here.
 */
export function pruneJournal(
  agentId: string,
  conversationId: string,
  maxBytes = MAX_WORK_STATE_BYTES_PER_CONVERSATION,
): Effect.Effect<number, never, never> {
  return workStateSizeBytes(agentId, conversationId).pipe(
    Effect.flatMap((size) => {
      if (size <= maxBytes) return Effect.succeed(0);
      return readJournal(agentId, conversationId).pipe(
        Effect.flatMap((entries) => {
          // Halve the record count rather than trimming one at a time, so pruning is
          // amortized instead of running on every subsequent append.
          const keep = entries.slice(Math.ceil(entries.length / 2));
          const dropped = entries.length - keep.length;
          return Effect.tryPromise({
            try: async () => {
              await nodeFs.writeFile(
                journalPath(agentId, conversationId),
                keep.map((entry) => JSON.stringify(entry)).join("\n") + (keep.length ? "\n" : ""),
                "utf-8",
              );
              return dropped;
            },
            catch: (error) => error,
          }).pipe(Effect.catchAll(() => Effect.succeed(0)));
        }),
      );
    }),
  );
}
