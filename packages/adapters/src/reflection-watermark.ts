/**
 * How far each conversation has been reflected on, so a conversation closed, reopened and closed
 * again is reflected on only for what was said since.
 *
 * A range is claimed before the pass runs, not after: two reflections of one conversation
 * (switching away, then quitting) must not both propose lessons from the same messages, and a
 * pass that fails part-way costs those messages a reflection rather than duplicating proposals.
 */

import * as path from "node:path";
import type { ChatMessage } from "@jazz/core/types/message";
import { toError } from "@jazz/core/utils/errors";
import { decodeStateFile, encodeStateFile, type StateFileKind } from "@jazz/core/utils/state-file";
import { writeFileStringAtomic } from "@jazz/core/utils/storage";
import { Effect, FileSystem } from "effect";
import { withMemoryWriteLock } from "./memory-write-lock";

const WATERMARK_FILENAME = ".reflected-conversations.json";

/** Conversations tracked. Past this the least recently reflected are dropped, and at worst re-reflected. */
const MAX_TRACKED_CONVERSATIONS = 2_000;

interface ReflectionWatermarks {
  /** Last reflected message entry id, keyed by `agentId/conversationId`, oldest first. */
  readonly lastEntryIdByConversation: Readonly<Record<string, string>>;
}

const WATERMARK_KIND: StateFileKind<ReflectionWatermarks> = {
  noun: "reflection watermarks",
  schemaVersion: 1,
  parse: (document) => {
    const record =
      typeof document === "object" && document !== null && !Array.isArray(document)
        ? (document as Record<string, unknown>)["lastEntryIdByConversation"]
        : undefined;
    if (
      typeof record !== "object" ||
      record === null ||
      Array.isArray(record) ||
      !Object.values(record).every((value) => typeof value === "string")
    ) {
      return { ok: false, error: "expected reflection watermarks" };
    }
    return {
      ok: true,
      content: { lastEntryIdByConversation: record as Record<string, string> },
    };
  },
  serialize: (watermarks) => ({ ...watermarks }),
};

function readWatermarks(
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<ReflectionWatermarks, Error> {
  return Effect.gen(function* () {
    const exists = yield* fs.exists(file).pipe(Effect.mapError(toError));
    if (!exists) {
      return { lastEntryIdByConversation: {} };
    }
    const raw = yield* fs.readFileString(file).pipe(Effect.mapError(toError));
    const decoded = decodeStateFile(raw, file, WATERMARK_KIND);
    return decoded.status === "ok" ? decoded.content : { lastEntryIdByConversation: {} };
  });
}

/**
 * The messages after the last reflected one, marked as reflected. When the watermark's message
 * is no longer in the history (compaction folded it into a summary), the whole history is
 * returned: the summary still describes what happened.
 */
export function claimUnreflectedMessages(
  memoryDirectory: string,
  agentId: string,
  conversationId: string,
  messages: readonly ChatMessage[],
): Effect.Effect<readonly ChatMessage[], Error, FileSystem.FileSystem> {
  const file = path.join(memoryDirectory, WATERMARK_FILENAME);
  const key = `${agentId}/${conversationId}`;
  return withMemoryWriteLock(
    memoryDirectory,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const watermarks = yield* readWatermarks(fs, file);
      const lastEntryId = watermarks.lastEntryIdByConversation[key];
      const watermarkIndex =
        lastEntryId === undefined
          ? -1
          : messages.findIndex((message) => message.entryId === lastEntryId);
      const unreflected = messages
        .slice(watermarkIndex + 1)
        .filter((message) => message.role !== "system");
      const newestEntryId = [...messages]
        .reverse()
        .find((message) => message.entryId !== undefined)?.entryId;
      if (unreflected.length === 0 || newestEntryId === undefined) {
        return [];
      }
      const { [key]: _previous, ...others } = watermarks.lastEntryIdByConversation;
      const kept = Object.entries(others).slice(-(MAX_TRACKED_CONVERSATIONS - 1));
      yield* writeFileStringAtomic(
        file,
        encodeStateFile(WATERMARK_KIND, {
          lastEntryIdByConversation: { ...Object.fromEntries(kept), [key]: newestEntryId },
        }),
      );
      return unreflected;
    }),
  );
}
