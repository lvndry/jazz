/**
 * A record of whether each run actually consulted memory before answering.
 *
 * `view_memory` is tool-call-gated with no preload: nothing injects memory into
 * context, so a run's continuity depends entirely on the model choosing to spend
 * a call before it answers. Whether that happens is an empirical question about
 * a specific surface, not something the unit suite can settle — a casual opener
 * on a chat bridge is the case most likely to skip it, and the least likely to
 * be noticed. This sink makes the rate measurable.
 *
 * Append-only JSONL, unparseable lines skipped, failures swallowed — the same
 * discipline as the misfire log, for the same reason: losing a recall entry must
 * never fail the run that produced it.
 */
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import type { ChatMessage } from "@/core/types/message";
import { getMemoryRecallLogDirectory } from "@/core/utils/paths";

const MEMORY_RECALL_LOG_FILENAME = "memory-recall.jsonl";

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

/**
 * Whether the last write was cut off mid-line: a process killed mid-append must
 * not splice the next entry into a broken line.
 */
async function endsMidLine(): Promise<boolean> {
  let handle;
  try {
    handle = await nodeFs.open(memoryRecallLogPath(), "r");
    const { size } = await handle.stat();
    if (size === 0) return false;
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, size - 1);
    return tail.toString("utf-8") !== "\n";
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
      await nodeFs.mkdir(getMemoryRecallLogDirectory(), { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      await nodeFs.appendFile(
        memoryRecallLogPath(),
        (await endsMidLine()) ? `\n${line}` : line,
        "utf-8",
      );
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
    try: () => nodeFs.readFile(memoryRecallLogPath(), "utf-8"),
    catch: (error) => error,
  }).pipe(
    Effect.map((content) => {
      const entries: MemoryRecallEntry[] = [];
      for (const line of content.split("\n")) {
        const entry = parseLine(line);
        if (entry === undefined) continue;
        if (filter?.surface !== undefined && entry.surface !== filter.surface) continue;
        entries.push(entry);
      }
      entries.reverse();
      return filter?.limit !== undefined ? entries.slice(0, filter.limit) : entries;
    }),
    Effect.catchAll(() => Effect.succeed([] as readonly MemoryRecallEntry[])),
  );
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
