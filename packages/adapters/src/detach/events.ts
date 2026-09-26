/**
 * Append-only event log for one detached conversation, read back by `jazz detach attach`.
 *
 * The remote daemon records a compact projection of the run's stream events plus job
 * lifecycle changes. Readers resume by byte offset, so an attach client that disconnects
 * replays exactly what it missed. Text deltas are coalesced before they hit disk so a long
 * answer is a handful of lines, not one line per token.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "@jazz/core/interfaces/presentation";
import type { StreamEvent } from "@jazz/core/types/streaming";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Past this size only lifecycle events are recorded; transcript text stops growing the log. */
const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;
/** Upper bound on one read, so a replay of a large log streams in bounded chunks. */
const MAX_READ_BYTES = 1024 * 1024;
const TEXT_FLUSH_MS = 250;
const MAX_SUMMARY_CHARS = 240;

export type DetachEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "response_end" }
  | {
      readonly type: "tool_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments?: string;
    }
  | {
      readonly type: "tool_end";
      readonly toolCallId: string;
      readonly success: boolean;
      readonly durationMs: number;
      readonly summary?: string;
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "status"; readonly state: string; readonly detail?: string };

export type TimedDetachEvent = DetachEvent & { readonly at: string };

export function detachEventLogPath(handoffId: string): string {
  if (!ID.test(handoffId)) {
    throw new Error("Invalid detach handoff ID");
  }
  return path.join(getJazzHomeDirectory(), "detach", "jobs", `${handoffId}.events.ndjson`);
}

function clip(text: string): string {
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
}

/**
 * Map a runner stream event onto the persisted vocabulary; most events carry nothing to replay.
 * Approval requests are left out: a resumed run re-emits the request it already parked on, and
 * the parked status names what is pending.
 */
export function projectStreamEvent(event: StreamEvent): DetachEvent | undefined {
  switch (event.type) {
    case "text_chunk":
      return event.delta.length > 0 ? { type: "text", delta: event.delta } : undefined;
    case "complete":
      return { type: "response_end" };
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.arguments !== undefined && Object.keys(event.arguments).length > 0
          ? { arguments: clip(JSON.stringify(event.arguments)) }
          : {}),
      };
    case "tool_execution_complete": {
      const summary = event.success === false ? event.error : event.summary;
      return {
        type: "tool_end",
        toolCallId: event.toolCallId,
        success: event.success !== false,
        durationMs: event.durationMs,
        ...(summary !== undefined && summary.length > 0 ? { summary: clip(summary) } : {}),
      };
    }
    case "error":
      return { type: "error", message: clip(event.error.message) };
    default:
      return undefined;
  }
}

/** Serializes appends for one handoff and coalesces adjacent text deltas. */
export class DetachEventRecorder {
  private pendingText = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private bytes: number | undefined;
  /** Whether this turn streamed any answer text; a batch-mode turn records its answer at the end. */
  sawText = false;

  constructor(private readonly handoffId: string) {}

  record(event: DetachEvent): void {
    if (event.type === "text") {
      this.sawText = true;
      this.pendingText += event.delta;
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        this.flushText();
      }, TEXT_FLUSH_MS);
      return;
    }
    this.flushText();
    this.enqueue(event);
  }

  recordStream(event: StreamEvent): void {
    const projected = projectStreamEvent(event);
    if (projected !== undefined) {
      this.record(projected);
    }
  }

  /** Resolve once every recorded event is on disk. */
  async close(): Promise<void> {
    this.flushText();
    await this.writes;
  }

  private flushText(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pendingText.length === 0) {
      return;
    }
    const delta = this.pendingText;
    this.pendingText = "";
    this.enqueue({ type: "text", delta });
  }

  private enqueue(event: DetachEvent): void {
    const line = `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`;
    this.writes = this.writes.then(() => this.append(event, line)).catch(() => undefined);
  }

  private async append(event: DetachEvent, line: string): Promise<void> {
    const file = detachEventLogPath(this.handoffId);
    if (this.bytes === undefined) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      this.bytes = (await fs.stat(file).catch(() => undefined))?.size ?? 0;
    }
    const lifecycle = event.type === "status" || event.type === "user";
    if (!lifecycle && this.bytes + line.length > MAX_EVENT_LOG_BYTES) {
      return;
    }
    await fs.appendFile(file, line, { mode: 0o600 });
    this.bytes += Buffer.byteLength(line);
  }
}

/** Append one lifecycle event outside a run, such as a queued reply or a status change. */
export async function appendDetachEvent(handoffId: string, event: DetachEvent): Promise<void> {
  const recorder = new DetachEventRecorder(handoffId);
  recorder.record(event);
  await recorder.close();
}

/**
 * Read complete lines starting at `sinceByte`. A trailing partial line is left for the next
 * read, so `nextByte` always lands on a line boundary.
 */
export async function readDetachEventLines(
  handoffId: string,
  sinceByte: number,
): Promise<{ readonly lines: readonly string[]; readonly nextByte: number }> {
  if (!Number.isSafeInteger(sinceByte) || sinceByte < 0) {
    throw new Error("Invalid event offset");
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(detachEventLogPath(handoffId), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], nextByte: 0 };
    }
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, sinceByte);
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { lines: [], nextByte: sinceByte };
    }
    const text = buffer.subarray(0, lastNewline).toString("utf8");
    return { lines: text.split("\n"), nextByte: sinceByte + lastNewline + 1 };
  } finally {
    await handle.close();
  }
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Validate a line from a remote host before it reaches the terminal. */
export function parseDetachEvent(line: string): TimedDetachEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const event = parsed as Record<string, unknown>;
  if (typeof event["at"] !== "string") {
    return undefined;
  }
  const valid = (() => {
    switch (event["type"]) {
      case "user":
        return typeof event["text"] === "string";
      case "text":
        return typeof event["delta"] === "string";
      case "response_end":
        return true;
      case "tool_start":
        return (
          typeof event["toolCallId"] === "string" &&
          typeof event["toolName"] === "string" &&
          optionalString(event["arguments"])
        );
      case "tool_end":
        return (
          typeof event["toolCallId"] === "string" &&
          typeof event["success"] === "boolean" &&
          typeof event["durationMs"] === "number" &&
          optionalString(event["summary"])
        );
      case "error":
        return typeof event["message"] === "string";
      case "status":
        return typeof event["state"] === "string" && optionalString(event["detail"]);
      default:
        return false;
    }
  })();
  return valid ? (parsed as TimedDetachEvent) : undefined;
}

/** Delegate everything, but tee every streamed event of this run into the recorder. */
export function recordingPresentationService(
  inner: PresentationService,
  recorder: DetachEventRecorder,
): PresentationService {
  const wrapRenderer = (renderer: StreamingRenderer): StreamingRenderer =>
    new Proxy(renderer, {
      get(target, property) {
        if (property === "handleEvent") {
          return (event: StreamEvent) =>
            Effect.sync(() => recorder.recordStream(event)).pipe(
              Effect.zipRight(target.handleEvent(event)),
            );
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  return new Proxy(inner, {
    get(target, property) {
      if (property === "createStreamingRenderer") {
        return (config: StreamingRendererConfig) =>
          target.createStreamingRenderer(config).pipe(Effect.map(wrapRenderer));
      }
      if (property === "emitsToolEventsViaRenderer") {
        return () => true;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
