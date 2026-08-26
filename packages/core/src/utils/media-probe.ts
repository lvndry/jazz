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
 *   to whatever the host already has: `ffprobe` when present (it is not installed on a stock
 *   macOS or Debian), then `afinfo` for audio on macOS, where it is always present. Video has
 *   no fallback — see `probeWithAfinfo`.
 * - **Failure is always allowed.** Every probe returns undefined rather than throwing. A
 *   missing dimension costs estimate accuracy, and the estimator compensates by assuming the
 *   expensive case. It must never cost the user their request.
 */

import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { checkExternalTool } from "@/core/agent/tools/fs/utils";
import type { AttachmentKind } from "@/core/types/attachment";

export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

/** Shipped with macOS as part of the CoreAudio command-line tools. */
const AFINFO_PATH = "/usr/bin/afinfo";

/**
 * How much of a file's head to read when looking for dimensions.
 *
 * PNG, GIF and WebP need only the first few dozen bytes. JPEG is the reason for the slack: its
 * dimensions live in an SOFn segment that sits *after* any APP0/EXIF metadata, and an embedded
 * EXIF thumbnail can push that well past a kilobyte. 4KB clears every real-world case without
 * reading a whole photo off disk.
 */
const IMAGE_HEADER_READ_BYTES = 4096;

async function readHeader(filePath: string, byteCount: number): Promise<Buffer | null> {
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

/**
 * PNG (spec 5.2, 11.2.2): an 8-byte signature, then the IHDR chunk — 4-byte length, 4-byte type
 * ("IHDR"), then chunk data opening with big-endian width and height.
 *
 * So width sits at 8 + 4 + 4 = 16, and height 4 bytes after it.
 */
const PNG = {
  /** First 4 bytes of the signature: \x89 P N G. */
  MAGIC: 0x89504e47,
  WIDTH_OFFSET: 16,
  HEIGHT_OFFSET: 20,
  /** Through the end of the height field. */
  MIN_BYTES: 24,
} as const;

function parsePngDimensions(header: Buffer): MediaDimensions | undefined {
  if (header.length < PNG.MIN_BYTES) return undefined;
  if (header.readUInt32BE(0) !== PNG.MAGIC) return undefined;
  return {
    width: header.readUInt32BE(PNG.WIDTH_OFFSET),
    height: header.readUInt32BE(PNG.HEIGHT_OFFSET),
  };
}

/**
 * GIF (spec 17, 18): a 6-byte header ("GIF87a" or "GIF89a") followed by the Logical Screen
 * Descriptor, which opens with width then height as *little-endian* 16-bit values — the
 * opposite byte order to PNG, which is the easy mistake here.
 */
const GIF = {
  MAGIC_ASCII: "GIF",
  MAGIC_LENGTH: 3,
  WIDTH_OFFSET: 6,
  HEIGHT_OFFSET: 8,
  /** Through the end of the height field. */
  MIN_BYTES: 10,
} as const;

function parseGifDimensions(header: Buffer): MediaDimensions | undefined {
  if (header.length < GIF.MIN_BYTES) return undefined;
  if (header.toString("ascii", 0, GIF.MAGIC_LENGTH) !== GIF.MAGIC_ASCII) return undefined;
  return {
    width: header.readUInt16LE(GIF.WIDTH_OFFSET),
    height: header.readUInt16LE(GIF.HEIGHT_OFFSET),
  };
}

/**
 * JPEG (ITU-T T.81) is not a fixed layout — it is a chain of marker segments, so dimensions can
 * only be found by walking it. Each segment is `0xFF <marker>`, then a 2-byte big-endian length
 * covering the length field itself, then the payload. Dimensions live in a Start-Of-Frame
 * segment, whose payload is: 1 byte precision, 2 bytes height, 2 bytes width — height first,
 * which is the opposite of every other format here.
 */
const JPEG = {
  /** Start of Image, the first two bytes of any JPEG. */
  SOI: 0xffd8,
  /** Every marker is introduced by this byte. */
  MARKER_PREFIX: 0xff,
  /** Markers that stand alone with no length field or payload. */
  SOI_MARKER: 0xd8,
  TEM_MARKER: 0x01,
  RESTART_FIRST: 0xd0,
  RESTART_LAST: 0xd7,
  /** SOFn occupies 0xC0-0xCF, but three values in that range are other things. */
  SOF_FIRST: 0xc0,
  SOF_LAST: 0xcf,
  /** Define Huffman Table — inside the SOF range but not a frame header. */
  DHT_MARKER: 0xc4,
  /** JPG extension — likewise. */
  JPG_MARKER: 0xc8,
  /** Define Arithmetic Coding — likewise. */
  DAC_MARKER: 0xcc,
  /** Bytes from the marker start to the segment's length field. */
  LENGTH_FIELD_OFFSET: 2,
  /** Marker (2) + length (2) + precision (1) = height. */
  SOF_HEIGHT_OFFSET: 5,
  SOF_WIDTH_OFFSET: 7,
  /** Smallest segment length that is not corrupt: the length field counts itself. */
  MIN_SEGMENT_LENGTH: 2,
  /** Enough for the SOI marker alone; the walk re-checks bounds as it goes. */
  MIN_BYTES: 4,
} as const;

/** Bytes the walker must be able to read before inspecting a candidate SOF segment. */
const JPEG_SOF_FIELDS_BYTES = JPEG.SOF_WIDTH_OFFSET + 2;

function isStandaloneJpegMarker(marker: number): boolean {
  return (
    marker === JPEG.SOI_MARKER ||
    marker === JPEG.TEM_MARKER ||
    (marker >= JPEG.RESTART_FIRST && marker <= JPEG.RESTART_LAST)
  );
}

function isJpegStartOfFrame(marker: number): boolean {
  if (marker < JPEG.SOF_FIRST || marker > JPEG.SOF_LAST) return false;
  return marker !== JPEG.DHT_MARKER && marker !== JPEG.JPG_MARKER && marker !== JPEG.DAC_MARKER;
}

function parseJpegDimensions(header: Buffer): MediaDimensions | undefined {
  if (header.length < JPEG.MIN_BYTES) return undefined;
  if (header.readUInt16BE(0) !== JPEG.SOI) return undefined;

  let offset = JPEG.LENGTH_FIELD_OFFSET;
  while (offset + JPEG_SOF_FIELDS_BYTES < header.length) {
    if (header[offset] !== JPEG.MARKER_PREFIX) {
      // Padding or a corrupt byte; resynchronize on the next marker prefix.
      offset++;
      continue;
    }
    const marker = header[offset + 1];
    if (marker === undefined) return undefined;

    if (isStandaloneJpegMarker(marker)) {
      offset += JPEG.LENGTH_FIELD_OFFSET;
      continue;
    }

    if (isJpegStartOfFrame(marker)) {
      return {
        height: header.readUInt16BE(offset + JPEG.SOF_HEIGHT_OFFSET),
        width: header.readUInt16BE(offset + JPEG.SOF_WIDTH_OFFSET),
      };
    }

    const segmentLength = header.readUInt16BE(offset + JPEG.LENGTH_FIELD_OFFSET);
    if (segmentLength < JPEG.MIN_SEGMENT_LENGTH) return undefined;
    offset += JPEG.LENGTH_FIELD_OFFSET + segmentLength;
  }
  return undefined;
}

/**
 * WebP is a RIFF container — "RIFF", 4-byte file size, "WEBP", then one of three payload chunks
 * that each store dimensions differently. The chunk type at offset 12 decides which.
 *
 * Dimensions are 14-bit in the VP8 variants, hence the 0x3FFF masks, and the lossless and
 * extended variants store them minus one.
 */
const WEBP = {
  RIFF_ASCII: "RIFF",
  RIFF_END: 4,
  WEBP_ASCII: "WEBP",
  WEBP_START: 8,
  WEBP_END: 12,
  /** Four-character chunk type: "VP8 " (lossy), "VP8L" (lossless) or "VP8X" (extended). */
  CHUNK_TYPE_START: 12,
  CHUNK_TYPE_END: 16,
  /** 14-bit fields; the top 2 bits of each 16-bit read are scaling hints, not size. */
  DIMENSION_MASK: 0x3fff,

  /** Lossy: dimensions follow the 3-byte frame-tag and start code. */
  VP8_WIDTH_OFFSET: 26,
  VP8_HEIGHT_OFFSET: 28,

  /** Lossless: width and height packed into one 32-bit little-endian field, each minus one. */
  VP8L_PACKED_OFFSET: 21,
  VP8L_HEIGHT_SHIFT: 14,

  /** Extended: 24-bit canvas width and height, each minus one. */
  VP8X_WIDTH_OFFSET: 24,
  VP8X_HEIGHT_OFFSET: 27,
  VP8X_FIELD_BYTES: 3,

  /** Through the end of the furthest field any variant reads (VP8 height at 28). */
  MIN_BYTES: 30,
} as const;

function parseWebpDimensions(header: Buffer): MediaDimensions | undefined {
  if (header.length < WEBP.MIN_BYTES) return undefined;
  if (header.toString("ascii", 0, WEBP.RIFF_END) !== WEBP.RIFF_ASCII) return undefined;
  if (header.toString("ascii", WEBP.WEBP_START, WEBP.WEBP_END) !== WEBP.WEBP_ASCII) {
    return undefined;
  }

  const chunkType = header.toString("ascii", WEBP.CHUNK_TYPE_START, WEBP.CHUNK_TYPE_END);

  if (chunkType === "VP8 ") {
    return {
      width: header.readUInt16LE(WEBP.VP8_WIDTH_OFFSET) & WEBP.DIMENSION_MASK,
      height: header.readUInt16LE(WEBP.VP8_HEIGHT_OFFSET) & WEBP.DIMENSION_MASK,
    };
  }
  if (chunkType === "VP8L") {
    const packed = header.readUInt32LE(WEBP.VP8L_PACKED_OFFSET);
    return {
      width: (packed & WEBP.DIMENSION_MASK) + 1,
      height: ((packed >> WEBP.VP8L_HEIGHT_SHIFT) & WEBP.DIMENSION_MASK) + 1,
    };
  }
  if (chunkType === "VP8X") {
    return {
      width: header.readUIntLE(WEBP.VP8X_WIDTH_OFFSET, WEBP.VP8X_FIELD_BYTES) + 1,
      height: header.readUIntLE(WEBP.VP8X_HEIGHT_OFFSET, WEBP.VP8X_FIELD_BYTES) + 1,
    };
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
  const header = await readHeader(filePath, IMAGE_HEADER_READ_BYTES);
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

/**
 * Audio duration via `afinfo`, which ships with macOS as part of the CoreAudio tools.
 *
 * Worth a separate path from ffprobe because ffmpeg is not installed on a stock Mac, while
 * `afinfo` always is — and it reads Ogg/Opus, which is the format Telegram voice notes arrive
 * in. So on the most common jazz-on-macOS audio path, this is the probe that actually runs.
 *
 * **Audio only.** On a video file `afinfo` reports the duration of the *audio track*, not the
 * clip: a 5s video with a 1.7s audio track reports 1.7s. Under-reporting duration
 * under-estimates tokens, which fails a request rather than merely compacting early — so video
 * must never come through here.
 */
export async function probeWithAfinfo(filePath: string): Promise<number | undefined> {
  if (process.platform !== "darwin") return undefined;
  // Not `checkExternalTool`: that treats a non-zero exit as "missing", and `afinfo` exits 1 for
  // every probe form including `-h` and no arguments — so it would always read as absent. It
  // lives at a fixed path as part of the OS, so checking for the file is both correct and
  // cheaper than a spawn.
  if (!existsSync(AFINFO_PATH)) return undefined;

  const { spawn } = await import("node:child_process");
  return new Promise<number | undefined>((resolve) => {
    const child = spawn(AFINFO_PATH, [filePath], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_000) stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      // afinfo prints "estimated duration: 1.693061 sec" among several key/value lines.
      const match = /estimated duration:\s*([0-9.]+)/i.exec(stdout);
      const seconds = match?.[1] === undefined ? Number.NaN : Number.parseFloat(match[1]);
      resolve(Number.isFinite(seconds) ? seconds : undefined);
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
  if (kind === "video") {
    // ffprobe or nothing: the macOS fallback reads only the audio track and would report a
    // clip as shorter than it is.
    return await probeWithFfprobe(filePath);
  }
  if (kind === "audio") {
    const viaFfprobe = await probeWithFfprobe(filePath);
    if (viaFfprobe.durationSeconds !== undefined) return viaFfprobe;

    const seconds = await probeWithAfinfo(filePath);
    return seconds === undefined ? {} : { durationSeconds: seconds };
  }
  return {};
}
