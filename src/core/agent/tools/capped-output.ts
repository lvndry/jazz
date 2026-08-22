/**
 * Byte-accurate, stream-safe output cap for spawned processes.
 *
 * Caps while collecting so an unbounded stdout never balloons memory before
 * being sliced down. Tracks raw `Buffer` chunks and decodes once so a UTF-8
 * character split across `data` events survives intact.
 */

export interface CappedOutput {
  readonly chunks: readonly Buffer[];
  readonly bytes: number;
  /** True once at least one byte past `capBytes` was discarded. */
  readonly truncated: boolean;
}

export const EMPTY_CAPPED_OUTPUT: CappedOutput = { chunks: [], bytes: 0, truncated: false };

/**
 * Append a raw stdout/stderr `chunk` (as delivered by Node's child_process
 * stream, before any string decoding) to `current`, truncating so the
 * combined output never exceeds `capBytes` BYTES — measured via
 * `Buffer.byteLength`/`Buffer.subarray`, not `String.prototype.length` (which
 * counts UTF-16 code units and undercounts multi-byte UTF-8 output). Caps per
 * chunk (not post-hoc) so an unbounded stream never balloons memory before
 * being sliced down.
 *
 * Deliberately keeps the raw `Buffer` chunks rather than decoding here: a
 * multi-byte UTF-8 character can straddle two separate `data` events (or,
 * post-cap, straddle the truncation cut itself), and decoding chunk-by-chunk
 * would turn each half into a replacement character (U+FFFD). Decoding is
 * deferred to `decodeCapped`, which runs once over the fully concatenated
 * buffer so only in-stream chunk seams are healed — a character split by the
 * cap cut itself can still yield one trailing replacement character, which is
 * an acceptable, inherent cost of truncating raw bytes.
 */
export function appendCapped(current: CappedOutput, chunk: Buffer, capBytes: number): CappedOutput {
  if (chunk.byteLength === 0) {
    return current;
  }
  if (current.bytes >= capBytes) {
    return current.truncated ? current : { ...current, truncated: true };
  }
  const remainingBytes = capBytes - current.bytes;
  if (chunk.byteLength <= remainingBytes) {
    return {
      chunks: [...current.chunks, chunk],
      bytes: current.bytes + chunk.byteLength,
      truncated: current.truncated,
    };
  }
  return {
    chunks: [...current.chunks, chunk.subarray(0, remainingBytes)],
    bytes: capBytes,
    truncated: true,
  };
}

/** Decode a `CappedOutput`'s accumulated raw chunks to a UTF-8 string, once, over the full concatenated buffer. */
export function decodeCapped(current: CappedOutput): string {
  return Buffer.concat(current.chunks).toString("utf8");
}

/**
 * Per-stream cap for Jazz-spawned process output (`execute_command`, git,
 * find/grep). Larger than the custom-tool 16 KB cap because these commands
 * often need a test log, a moderate diff, or a search result set; still a
 * hard bound so a flood cannot grow until the timeout.
 */
export const DEFAULT_SPAWN_OUTPUT_CAP_BYTES = 256 * 1024;

export function spawnOutputTruncationNotice(
  streamName: "stdout" | "stderr",
  capBytes: number = DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
): string {
  return `[truncated: ${streamName} exceeded ${capBytes} bytes; showing the first ${capBytes} bytes. Narrow the command (path, range, grep, or read_file with startLine/endLine) if you need a different slice.]`;
}

export interface DecodeCappedTextOptions {
  readonly trim?: "all" | "end";
  /**
   * When the cap cut mid-line, drop that incomplete last line so parsers
   * (find paths, grep matches, git blame) do not treat a partial line as a
   * real result.
   */
  readonly dropIncompleteLastLine?: boolean;
}

/**
 * Decode capped output for a caller that will either show it or parse it.
 */
export function decodeCappedText(
  output: CappedOutput,
  options: DecodeCappedTextOptions = {},
): { readonly text: string; readonly truncated: boolean } {
  let text = decodeCapped(output);
  if (output.truncated && options.dropIncompleteLastLine === true) {
    const lastNewline = text.lastIndexOf("\n");
    text = lastNewline === -1 ? "" : text.slice(0, lastNewline);
  }
  text = options.trim === "end" ? text.trimEnd() : text.trim();
  return { text, truncated: output.truncated };
}

/**
 * Decode and, if truncated, append a model-visible notice. Used when the
 * stream is the result the model reads (execute_command), not when a parser
 * will split it into structured fields.
 */
export function formatCappedStream(
  output: CappedOutput,
  streamName: "stdout" | "stderr",
  capBytes: number = DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
): string {
  const { text, truncated } = decodeCappedText(output, { trim: "all" });
  if (!truncated) {
    return text;
  }
  return `${text}\n${spawnOutputTruncationNotice(streamName, capBytes)}`;
}

export interface CollectedProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/**
 * Attach byte-capped collectors to a child's stdio. Call the returned
 * snapshot function after `close` to read the accumulated output.
 */
export function bindCappedStdio(
  stdout: { on: (event: "data", listener: (data: Buffer) => void) => unknown } | null | undefined,
  stderr: { on: (event: "data", listener: (data: Buffer) => void) => unknown } | null | undefined,
  capBytes: number = DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
): () => { stdout: CappedOutput; stderr: CappedOutput } {
  let out = EMPTY_CAPPED_OUTPUT;
  let err = EMPTY_CAPPED_OUTPUT;
  stdout?.on("data", (data: Buffer) => {
    out = appendCapped(out, data, capBytes);
  });
  stderr?.on("data", (data: Buffer) => {
    err = appendCapped(err, data, capBytes);
  });
  return () => ({ stdout: out, stderr: err });
}
