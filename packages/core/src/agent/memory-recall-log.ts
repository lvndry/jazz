/**
 * A record of whether each run actually consulted memory before answering.
 *
 * This log measures explicit `view_memory` calls. Standing entries can also
 * expose memory without a tool call, so these counts must not be interpreted
 * as total exposure or outcome credit.
 *
 * Append-only JSONL, unparseable lines skipped, failures swallowed — the same
 * discipline as the misfire log, for the same reason: losing a recall entry must
 * never fail the run that produced it.
 *
 * Bounded (`bounded-jsonl.ts`): past `MEMORY_RECALL_LOG_MAX_BYTES` the file rotates to
 * `memory-recall.jsonl.1`, so the recall rate describes recent runs, and reads scan
 * backwards from the end instead of loading the file.
 */
import * as path from "node:path";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { appendBoundedJsonlLine, readJsonlNewestFirst } from "@/core/utils/bounded-jsonl";
import { getMemoryRecallLogDirectory } from "@/core/utils/paths";

const MEMORY_RECALL_LOG_FILENAME = "memory-recall.jsonl";

/** Size at which the recall log rotates; an entry is about 200 bytes, so roughly 20,000 runs. */
export const MEMORY_RECALL_LOG_MAX_BYTES = 4 * 1024 * 1024;

export const VIEW_MEMORY_TOOL_NAME = "view_memory";
export const MANAGE_MEMORY_TOOL_NAME = "manage_memory";

/** What one finished run did with memory. */
export interface MemoryRecallObservation {
  /**
   * False when the run was never offered the memory tools at all (memory not in
   * `AgentConfig.tools`, or an ephemeral run). Such a run cannot be a miss, and
   * mixing it into the denominator would understate the recall rate.
   */
  readonly memoryToolsOffered: boolean;
  /**
   * The question this log exists to answer: did a `view_memory` call land before
   * the run's first substantive answer?
   */
  readonly viewedBeforeFirstAnswer: boolean;
  readonly viewCallCount: number;
  readonly writeCallCount: number;
}

export interface MemoryRecallEntry extends MemoryRecallObservation {
  readonly timestamp: string;
  /** Which front door this run came through: `cli`, `telegram`, `discord`, … */
  readonly surface: string;
  readonly agentId: string;
  readonly conversationId?: string;
}

export function memoryRecallLogPath(): string {
  return path.join(getMemoryRecallLogDirectory(), MEMORY_RECALL_LOG_FILENAME);
}

/**
 * The surface that started this run. Bots shell out to `jazz run`, so the
 * command name alone cannot tell a Telegram turn from a terminal one; each
 * bridge sets `JAZZ_SURFACE` instead. Absent the marker a run is plain CLI.
 */
export function currentSurface(): string {
  const declared = process.env["JAZZ_SURFACE"]?.trim();
  return declared !== undefined && declared.length > 0 ? declared : "cli";
}

function isSubstantiveAnswer(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    (message.tool_calls?.length ?? 0) === 0 &&
    message.content.trim().length > 0 &&
    // A compaction summary is bookkeeping the loop wrote, not an answer to the
    // user, so a view that lands after one has still landed before the answer.
    message.kind !== "summary"
  );
}

/**
 * Derives the observation from a finished transcript rather than from hooks
 * inside the loop: the ordering question is answerable from the messages alone,
 * which keeps this a pure function and leaves the loop untouched.
 */
export function analyzeMemoryRecall(
  messages: readonly ChatMessage[],
  memoryToolsOffered: boolean,
): MemoryRecallObservation {
  let viewCallCount = 0;
  let writeCallCount = 0;
  let firstViewIndex: number | undefined;
  let firstAnswerIndex: number | undefined;

  for (const [index, message] of messages.entries()) {
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.function.name === VIEW_MEMORY_TOOL_NAME) {
        viewCallCount += 1;
        firstViewIndex ??= index;
      } else if (toolCall.function.name === MANAGE_MEMORY_TOOL_NAME) {
        writeCallCount += 1;
      }
    }
    if (firstAnswerIndex === undefined && isSubstantiveAnswer(message)) {
      firstAnswerIndex = index;
    }
  }

  const viewedBeforeFirstAnswer =
    firstViewIndex !== undefined &&
    (firstAnswerIndex === undefined || firstViewIndex < firstAnswerIndex);

  return { memoryToolsOffered, viewedBeforeFirstAnswer, viewCallCount, writeCallCount };
}

/** Append one recall entry. Failure is swallowed: see file header. */
export function recordMemoryRecall(input: {
  readonly agentId: string;
  readonly conversationId?: string;
  readonly messages: readonly ChatMessage[];
  readonly memoryToolsOffered: boolean;
}): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      const entry: MemoryRecallEntry = {
        timestamp: new Date().toISOString(),
        surface: currentSurface(),
        agentId: input.agentId,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...analyzeMemoryRecall(input.messages, input.memoryToolsOffered),
      };
      await appendBoundedJsonlLine(memoryRecallLogPath(), JSON.stringify(entry), {
        maxBytes: MEMORY_RECALL_LOG_MAX_BYTES,
      });
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.void));
}

function parseLine(line: string): MemoryRecallEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entry = parsed as MemoryRecallEntry;
    if (typeof entry.surface !== "string" || typeof entry.agentId !== "string") return undefined;
    if (typeof entry.viewedBeforeFirstAnswer !== "boolean") return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

/** Entries newest first, optionally filtered by surface. */
export function readMemoryRecalls(filter?: {
  readonly surface?: string;
  readonly limit?: number;
}): Effect.Effect<readonly MemoryRecallEntry[], never> {
  return Effect.tryPromise({
    try: () =>
      readJsonlNewestFirst(memoryRecallLogPath(), {
        parse: (line) => {
          const entry = parseLine(line);
          return entry === undefined ||
            (filter?.surface !== undefined && entry.surface !== filter.surface)
            ? undefined
            : entry;
        },
        limit: filter?.limit,
        maxBytes: 2 * MEMORY_RECALL_LOG_MAX_BYTES,
      }),
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly MemoryRecallEntry[])));
}

/** Recall rate per surface, counting only runs that were offered the tools. */
export interface MemoryRecallRate {
  readonly surface: string;
  readonly eligibleRuns: number;
  readonly viewedBeforeFirstAnswer: number;
  readonly rate: number;
}

export function summarizeMemoryRecalls(
  entries: readonly MemoryRecallEntry[],
): readonly MemoryRecallRate[] {
  const bySurface = new Map<string, { eligible: number; viewed: number }>();
  for (const entry of entries) {
    if (!entry.memoryToolsOffered) continue;
    const bucket = bySurface.get(entry.surface) ?? { eligible: 0, viewed: 0 };
    bucket.eligible += 1;
    if (entry.viewedBeforeFirstAnswer) bucket.viewed += 1;
    bySurface.set(entry.surface, bucket);
  }
  return [...bySurface.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([surface, bucket]) => ({
      surface,
      eligibleRuns: bucket.eligible,
      viewedBeforeFirstAnswer: bucket.viewed,
      rate: bucket.eligible === 0 ? 0 : bucket.viewed / bucket.eligible,
    }));
}
