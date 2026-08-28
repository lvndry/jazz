/**
 * A record of tool calls that failed: runtime errors, tool-not-found, and
 * schema mismatches.
 *
 * Not the same thing as tool-logging.ts, which is a human-readable console/log-file
 * trace of every call. This is a structured, append-only JSONL sink meant to be mined
 * later for recurring failure patterns (Phase 1 of the self-improvement ratchet: see
 * project memory) — one entry captures enough to answer "which tool, called how, failed
 * why, how often" without re-parsing prose log lines.
 *
 * Append-only JSONL, unparseable lines skipped, failures swallowed — the same discipline
 * as the peer ledger, for the same reason: losing a misfire entry must never fail the
 * tool call that produced it.
 */
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import { getMisfireLogDirectory } from "@/core/utils/paths";
import { jsonBigIntReplacer } from "./tool-logging";

const MISFIRE_LOG_FILENAME = "misfires.jsonl";

/** Cap on the serialized args written to a misfire entry. */
const MAX_LOGGED_ARGS_LENGTH = 2_000;

export type MisfireKind = "runtime_error" | "tool_not_found";

export interface MisfireEntry {
  readonly timestamp: string;
  readonly toolName: string;
  readonly kind: MisfireKind;
  readonly errorMessage: string;
  readonly durationMs: number;
  readonly args?: string;
}

export function misfireLogPath(): string {
  return path.join(getMisfireLogDirectory(), MISFIRE_LOG_FILENAME);
}

function serialize(entry: MisfireEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

function serializeArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(args, jsonBigIntReplacer);
    return serialized.length > MAX_LOGGED_ARGS_LENGTH
      ? `${serialized.slice(0, MAX_LOGGED_ARGS_LENGTH)}...`
      : serialized;
  } catch {
    return undefined;
  }
}

/**
 * Whether the last write was cut off mid-line, mirroring the peer ledger's guard: a
 * process killed mid-append must not splice the next entry into a broken line.
 */
async function endsMidLine(): Promise<boolean> {
  let handle;
  try {
    handle = await nodeFs.open(misfireLogPath(), "r");
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

/** Append one misfire entry. Failure is swallowed: see file header. */
export function recordMisfire(
  toolName: string,
  kind: MisfireKind,
  errorMessage: string,
  durationMs: number,
  args?: Record<string, unknown>,
): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: async () => {
      const serializedArgs = serializeArgs(args);
      const entry: MisfireEntry = {
        timestamp: new Date().toISOString(),
        toolName,
        kind,
        errorMessage,
        durationMs,
        ...(serializedArgs !== undefined ? { args: serializedArgs } : {}),
      };
      await nodeFs.mkdir(getMisfireLogDirectory(), { recursive: true });
      const line = serialize(entry);
      await nodeFs.appendFile(
        misfireLogPath(),
        (await endsMidLine()) ? `\n${line}` : line,
        "utf-8",
      );
    },
    catch: (error) => error,
  }).pipe(Effect.catchAll(() => Effect.void));
}

function parseLine(line: string): MisfireEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entry = parsed as MisfireEntry;
    if (typeof entry.toolName !== "string" || typeof entry.kind !== "string") return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

/** Entries newest first, optionally filtered by tool name. */
export function readMisfires(filter?: {
  readonly toolName?: string;
  readonly limit?: number;
}): Effect.Effect<readonly MisfireEntry[], never> {
  return Effect.tryPromise({
    try: () => nodeFs.readFile(misfireLogPath(), "utf-8"),
    catch: (error) => error,
  }).pipe(
    Effect.map((content) => {
      const entries: MisfireEntry[] = [];
      for (const line of content.split("\n")) {
        const entry = parseLine(line);
        if (entry === undefined) continue;
        if (filter?.toolName !== undefined && entry.toolName !== filter.toolName) continue;
        entries.push(entry);
      }
      entries.reverse();
      return filter?.limit === undefined ? entries : entries.slice(0, filter.limit);
    }),
    Effect.catchAll(() => Effect.succeed([] as readonly MisfireEntry[])),
  );
}
