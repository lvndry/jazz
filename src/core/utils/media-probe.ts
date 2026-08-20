/**
 * @fileoverview Best-effort metadata probing for attachment files
 *
 * Token cost for media is a function of its shape, not its byte size: images bill by pixel
 * area, audio and video by duration. This module recovers those numbers so
 * `estimateAttachmentTokens` can do better than a flat constant.
 *
 * Design constraints:
 *
 * - **No new dependencies.** Image dimensions come from parsing the file header directly —
 *   every format here puts them in the first few dozen bytes, so there is no decode and no
 *   image library. Duration needs a container parser, which is genuinely hard, so we shell out
 *   to `ffprobe` *if it happens to be installed* and give up gracefully if not.
 * - **Failure is always allowed.** Every probe returns undefined rather than throwing. A
 *   missing dimension costs estimate accuracy, and the estimator compensates by assuming the
 *   expensive case. It must never cost the user their request.
 */

import { open } from "node:fs/promises";
import { checkExternalTool } from "@/core/agent/tools/fs/utils";
import type { AttachmentKind } from "@/core/types/attachment";

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

/** Bytes read from the head of a file when looking for dimensions. */
const HEADER_BYTES = 65_536;

async function readHeader(filePath: string, byteCount = HEADER_BYTES): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parsePngDimensions(header: Buffer): MediaDimensions | undefined {
  // PNG: 8-byte signature, then an IHDR chunk whose data begins at offset 16 with
  // big-endian width and height.
  if (header.length < 24) return undefined;
  if (header.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function parseGifDimensions(header: Buffer): MediaDimensions | undefined {
  // GIF: "GIF87a"/"GIF89a" then little-endian logical screen width and height.
  if (header.length < 10) return undefined;
  if (header.toString("ascii", 0, 3) !== "GIF") return undefined;
  return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
}

function parseJpegDimensions(header: Buffer): MediaDimensions | undefined {
  // JPEG is a chain of segments. Walk them until an SOFn frame header, which carries
  // height then width as big-endian 16-bit values three bytes into its payload.
  if (header.length < 4) return undefined;
  if (header.readUInt16BE(0) !== 0xffd8) return undefined;

  let offset = 2;
  while (offset + 9 < header.length) {
    if (header[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = header[offset + 1];
    if (marker === undefined) return undefined;

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = header.readUInt16BE(offset + 2);

    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: header.readUInt16BE(offset + 5), width: header.readUInt16BE(offset + 7) };
    }
    if (segmentLength < 2) return undefined;
    offset += 2 + segmentLength;
  }
  return undefined;
}

function parseWebpDimensions(header: Buffer): MediaDimensions | undefined {
  // WebP is RIFF-framed with three possible payload chunks, each storing dimensions
  // differently. All are 14-30 bytes in.
  if (header.length < 30) return undefined;
  if (header.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (header.toString("ascii", 8, 12) !== "WEBP") return undefined;

  const chunkType = header.toString("ascii", 12, 16);

  if (chunkType === "VP8 ") {
    // Lossy: 14-bit width and height after a 3-byte start code, masked to drop scale bits.
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === "VP8L") {
    // Lossless: 14-bit width and height packed into a 32-bit little-endian field.
    const packed = header.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1,
    };
  }
  if (chunkType === "VP8X") {
    // Extended: 24-bit canvas width and height, minus one.
    const width = header.readUIntLE(24, 3) + 1;
    const height = header.readUIntLE(27, 3) + 1;
    return { width, height };
  }
  return undefined;
}

/**
 * Pixel dimensions of an image, read from its header.
 *
 * Returns undefined for anything unrecognized or truncated — including a valid image in a
 * format not listed here, which is deliberate: guessing is worse than a conservative estimate.
 */
export async function probeImageDimensions(filePath: string): Promise<MediaDimensions | undefined> {
  const header = await readHeader(filePath, 4096);
  if (header === null || header.length < 10) return undefined;

  return (
    parsePngDimensions(header) ??
    parseJpegDimensions(header) ??
    parseGifDimensions(header) ??
    parseWebpDimensions(header)
  );
}

interface FfprobeResult {
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Duration (and, for video, dimensions) via `ffprobe`.
 *
 * ffprobe is not a jazz dependency and most machines will not have it. That is expected: this
 * returns an empty result and the estimator falls back to assuming a long file. Probed onto
 * `checkExternalTool`'s global cache, so the availability check costs one spawn per process.
 */
export async function probeWithFfprobe(filePath: string): Promise<FfprobeResult> {
  const available = await checkExternalTool("ffprobe", "-version");
  if (!available) return {};

  const { spawn } = await import("node:child_process");
  return new Promise<FfprobeResult>((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=width,height",
        "-of",
        "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    );

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      // Cap the buffer: a hostile or corrupt file should not be able to grow this unbounded.
      if (stdout.length < 64_000) stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve({}));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: Array<{ width?: number; height?: number }>;
        };
        const rawDuration = parsed.format?.duration;
        const durationSeconds =
          rawDuration === undefined ? undefined : Number.parseFloat(rawDuration);
        const visualStream = parsed.streams?.find(
          (stream) => typeof stream.width === "number" && typeof stream.height === "number",
        );
        resolve({
          ...(durationSeconds !== undefined && Number.isFinite(durationSeconds)
            ? { durationSeconds }
            : {}),
          ...(visualStream?.width !== undefined && { width: visualStream.width }),
          ...(visualStream?.height !== undefined && { height: visualStream.height }),
        });
      } catch {
        resolve({});
      }
    });
  });
}

export interface ProbedMediaShape {
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly pageCount?: number;
}

/**
 * Probe whatever shape metadata is cheaply available for a given modality.
 *
 * PDF page count is deliberately not probed here — it needs the pdf-parse loader, which is
 * lazily imported by the fs tools and pulls in a heavy dependency. Callers that already have a
 * page count pass it through; the estimator handles its absence.
 */
export async function probeMediaShape(
  filePath: string,
  kind: AttachmentKind,
): Promise<ProbedMediaShape> {
  if (kind === "image") {
    const dimensions = await probeImageDimensions(filePath);
    return dimensions ?? {};
  }
  if (kind === "audio" || kind === "video") {
    return await probeWithFfprobe(filePath);
  }
  return {};
}
