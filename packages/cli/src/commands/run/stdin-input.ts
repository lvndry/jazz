/**
 * @fileoverview The `jazz run --input-stdin` frame: a run's input as the first line on stdin.
 *
 * A caller that relays somebody else's words (a chat bridge) must not put them on the command
 * line: argv is readable by every account on the host through `ps` and `/proc/<pid>/cmdline`,
 * and Linux caps one argument at 128 KiB, so a long transcript fails outright. The frame moves
 * both the prompt and an ephemeral run's prior messages onto stdin:
 *
 *   {"prompt": "what's on my calendar?", "history": [ ...ChatMessage ]}\n
 *
 * Only the first line is the frame. Everything after it stays on the stream for the
 * `--interactive-stdin` protocol (approval decisions and answers), which is why the reader
 * stops at the first newline and hands the rest back instead of reading to end of stream.
 *
 * A framed prompt is the caller's own message, exactly like a positional prompt, so it may back
 * a memory write. A prompt piped without the frame stays untrusted text.
 */

import { isRecord } from "@jazz/core/utils/is-record";

export interface StdinRunInput {
  readonly prompt: string;
  /** Prior messages for an `--ephemeral` run, passed back from the last envelope's `messages`. */
  readonly history?: readonly unknown[];
}

export type StdinRunInputResult =
  | { readonly ok: true; readonly input: StdinRunInput }
  | { readonly ok: false; readonly error: string };

const FRAME_SHAPE = 'a JSON object like {"prompt": "...", "history": [...]}';

/** Parse the frame line. `history` is optional; anything else about the shape is an error. */
export function parseStdinRunInput(line: string | undefined): StdinRunInputResult {
  if (line === undefined || line.trim().length === 0) {
    return { ok: false, error: `--input-stdin read nothing from stdin. Write ${FRAME_SHAPE}.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: `--input-stdin needs ${FRAME_SHAPE} on the first line.` };
  }
  if (!isRecord(parsed) || typeof parsed["prompt"] !== "string") {
    return { ok: false, error: `--input-stdin needs ${FRAME_SHAPE} with a string "prompt".` };
  }
  const history = parsed["history"];
  if (history !== undefined && !Array.isArray(history)) {
    return { ok: false, error: '--input-stdin "history" must be an array of messages.' };
  }
  return {
    ok: true,
    input: { prompt: parsed["prompt"], ...(history !== undefined ? { history } : {}) },
  };
}

/**
 * Read one line from `stream` and leave everything after it unread.
 *
 * The stream is paused with the remainder pushed back, so the next reader (the one-shot
 * presentation service) resumes it and sees the protocol lines in order. Resolves with what
 * was read when the stream ends before a newline, and `undefined` when it ended empty.
 * Bytes are decoded only after the complete frame arrives; a chunk boundary may split a
 * UTF-8 character in either the frame or the protocol bytes left for the next reader.
 */
export function readFirstStdinLine(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: string | Buffer): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      const newlineIndex = bytes.indexOf(0x0a);
      if (newlineIndex < 0) {
        chunks.push(bytes);
        length += bytes.length;
        return;
      }
      cleanup();
      stream.pause();
      chunks.push(bytes.subarray(0, newlineIndex));
      length += newlineIndex;
      const remainder = bytes.subarray(newlineIndex + 1);
      if (remainder.length > 0) {
        stream.unshift(remainder);
      }
      resolve(Buffer.concat(chunks, length).toString("utf-8"));
    };
    const onEnd = (): void => {
      cleanup();
      resolve(length > 0 ? Buffer.concat(chunks, length).toString("utf-8") : undefined);
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
