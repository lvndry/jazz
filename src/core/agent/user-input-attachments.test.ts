/**
 * Detecting media paths in user input.
 *
 * The tension here is between two failure modes: missing a path the user meant (drag-and-drop
 * feels broken) and attaching something they didn't mean (a surprise upload). Requiring the file
 * to exist *and* have a media extension is what keeps ordinary prose from triggering it.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "@/core/types/attachment";
import { collectUserInputAttachments } from "./user-input-attachments";

/** A minimal but genuinely parseable PNG, so dimension probing has something to read. */
function pngBytes(width = 100, height = 50): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

async function fixtureDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "jazz-input-attach-"));
}

describe("collectUserInputAttachments", () => {
  it("finds an absolute path to an existing image", async () => {
    const directory = await fixtureDir();
    const imagePath = join(directory, "shot.png");
    await writeFile(imagePath, pngBytes());

    const result = await collectUserInputAttachments(`what is in ${imagePath}?`, directory);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.path).toBe(imagePath);
    expect(result.attachments[0]?.kind).toBe("image");
  });

  it("resolves a relative path against the working directory, not process.cwd()", async () => {
    const directory = await fixtureDir();
    await writeFile(join(directory, "diagram.png"), pngBytes());

    const result = await collectUserInputAttachments("look at ./diagram.png", directory);
    expect(result.attachments[0]?.path).toBe(join(directory, "diagram.png"));
  });

  it("accepts the @path form used elsewhere in jazz", async () => {
    const directory = await fixtureDir();
    await writeFile(join(directory, "shot.png"), pngBytes());

    const result = await collectUserInputAttachments("check @shot.png please", directory);
    expect(result.attachments).toHaveLength(1);
  });

  it("populates dimensions so the token estimate is not a guess", async () => {
    const directory = await fixtureDir();
    await writeFile(join(directory, "shot.png"), pngBytes(640, 480));

    const result = await collectUserInputAttachments("./shot.png", directory);
    expect(result.attachments[0]?.width).toBe(640);
    expect(result.attachments[0]?.height).toBe(480);
  });

  it("ignores prose that merely looks like a filename", async () => {
    const directory = await fixtureDir();
    const result = await collectUserInputAttachments(
      "update the v1.2 spec and bump config.yaml",
      directory,
    );
    expect(result.attachments).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("ignores a media path that does not exist, without warning about it", async () => {
    // Silence is right here: the user may just be talking about a file they plan to create.
    const directory = await fixtureDir();
    const result = await collectUserInputAttachments("I'll send you shot.png later", directory);
    expect(result.attachments).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("ignores non-media files even when they exist", async () => {
    const directory = await fixtureDir();
    await writeFile(join(directory, "notes.txt"), "hello");
    const result = await collectUserInputAttachments("read ./notes.txt", directory);
    expect(result.attachments).toHaveLength(0);
  });

  it("strips trailing sentence punctuation from a path", async () => {
    const directory = await fixtureDir();
    await writeFile(join(directory, "shot.png"), pngBytes());
    const result = await collectUserInputAttachments("look at ./shot.png.", directory);
    expect(result.attachments).toHaveLength(1);
  });

  it("deduplicates a path mentioned twice", async () => {
    const directory = await fixtureDir();
    const imagePath = join(directory, "shot.png");
    await writeFile(imagePath, pngBytes());
    const result = await collectUserInputAttachments(
      `${imagePath} and again ${imagePath}`,
      directory,
    );
    expect(result.attachments).toHaveLength(1);
  });

  it("warns rather than silently skipping a file over its size limit", async () => {
    const directory = await fixtureDir();
    const imagePath = join(directory, "huge.png");
    await writeFile(imagePath, Buffer.alloc(MAX_ATTACHMENT_BYTES.image + 1));

    const result = await collectUserInputAttachments(`${imagePath}`, directory);
    expect(result.attachments).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("limit");
  });

  it("skips ingestion entirely for input with no path-like tokens", async () => {
    const result = await collectUserInputAttachments("hello there", await fixtureDir());
    expect(result.attachments).toHaveLength(0);
  });
});
