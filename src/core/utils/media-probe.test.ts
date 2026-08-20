/**
 * Image header parsing.
 *
 * Dimensions drive the token estimate, and the estimate drives whether compaction fires — so a
 * parser that silently returns the wrong numbers is worse than one that returns nothing. Each
 * case here builds a minimal real header rather than using a fixture file, so the offsets being
 * asserted are visible in the test itself.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { probeImageDimensions, probeWithAfinfo } from "./media-probe";

async function writeTemp(name: string, bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jazz-media-probe-"));
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

/** PNG: 8-byte signature, IHDR length/type, then big-endian width and height. */
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** GIF: "GIF89a" then little-endian logical screen width and height. */
function gifHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

/** JPEG: SOI, a skipped APP0 segment, then an SOF0 frame carrying height before width. */
function jpegHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(32);
  let offset = 0;
  buffer.writeUInt16BE(0xffd8, offset);
  offset += 2;

  // APP0 with a 4-byte payload, present so the walker has a segment to skip.
  buffer.writeUInt16BE(0xffe0, offset);
  offset += 2;
  buffer.writeUInt16BE(4, offset);
  offset += 4;

  buffer.writeUInt16BE(0xffc0, offset);
  buffer.writeUInt16BE(17, offset + 2);
  buffer.writeUInt8(8, offset + 4);
  buffer.writeUInt16BE(height, offset + 5);
  buffer.writeUInt16BE(width, offset + 7);
  return buffer;
}

describe("probeImageDimensions", () => {
  it("reads PNG dimensions", async () => {
    const path = await writeTemp("a.png", pngHeader(1024, 768));
    expect(await probeImageDimensions(path)).toEqual({ width: 1024, height: 768 });
  });

  it("reads GIF dimensions (little-endian, unlike PNG)", async () => {
    const path = await writeTemp("a.gif", gifHeader(320, 200));
    expect(await probeImageDimensions(path)).toEqual({ width: 320, height: 200 });
  });

  it("reads JPEG dimensions, walking past intermediate segments", async () => {
    const path = await writeTemp("a.jpg", jpegHeader(640, 480));
    expect(await probeImageDimensions(path)).toEqual({ width: 640, height: 480 });
  });

  it("returns undefined for a file that is not an image", async () => {
    const path = await writeTemp("a.png", Buffer.from("this is just text, not a PNG at all"));
    expect(await probeImageDimensions(path)).toBeUndefined();
  });

  it("returns undefined for a truncated header rather than reading garbage", async () => {
    const path = await writeTemp("a.png", pngHeader(1024, 768).subarray(0, 12));
    expect(await probeImageDimensions(path)).toBeUndefined();
  });

  it("returns undefined for a missing file instead of throwing", async () => {
    expect(await probeImageDimensions("/nonexistent/nope.png")).toBeUndefined();
  });
});

/**
 * `afinfo` is the macOS-only audio fallback, exercised directly because a machine with ffmpeg
 * installed would otherwise never reach it — ffprobe answers first.
 *
 * Skipped off macOS, where `afinfo` does not exist. The AIFF fixture is generated with `say`,
 * which is also macOS-only, so both live behind the same guard.
 */
describe.skipIf(process.platform !== "darwin")("probeWithAfinfo", () => {
  it("reads the duration of an audio file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jazz-afinfo-"));
    const audioPath = join(directory, "spoken.aiff");
    const said = Bun.spawnSync(["say", "-o", audioPath, "one two three four"]);
    if (said.exitCode !== 0) return;

    const seconds = await probeWithAfinfo(audioPath);
    expect(seconds).toBeDefined();
    // A four-word utterance is comfortably inside this range at any speech rate.
    expect(seconds!).toBeGreaterThan(0.3);
    expect(seconds!).toBeLessThan(10);
  });

  it("returns undefined for a file that is not audio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jazz-afinfo-"));
    const path = join(directory, "notaudio.wav");
    await writeFile(path, Buffer.from("definitely not a wav file"));
    expect(await probeWithAfinfo(path)).toBeUndefined();
  });

  it("returns undefined for a missing file instead of throwing", async () => {
    expect(await probeWithAfinfo("/nonexistent/nope.mp3")).toBeUndefined();
  });
});
