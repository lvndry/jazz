import { writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveMediaAttachments } from "./media-attachments";

const directory = join(tmpdir(), "jazz-media-attachments-test");

async function makeFile(name: string, bytes: number): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, Buffer.alloc(bytes));
  return path;
}

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("resolveMediaAttachments", () => {
  it("resolves an existing image into an attachment with probed shape", async () => {
    // Minimal valid PNG header: signature, IHDR chunk with 1×1 dimensions.
    const path = join(directory, "pixel.png");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from([0, 0, 0, 13]),
        Buffer.from("IHDR", "ascii"),
        Buffer.from([0, 0, 0, 1]),
        Buffer.from([0, 0, 0, 1]),
        Buffer.alloc(9),
      ]),
    );

    const result = await resolveMediaAttachments([path], "image");

    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0]!;
    expect(attachment.kind).toBe("image");
    expect(attachment.path).toBe(path);
    expect(attachment.byteSize).toBeGreaterThan(0);
    expect(attachment.width).toBe(1);
    expect(attachment.height).toBe(1);
  });

  it("rejects a kind mismatch as a hard error", async () => {
    const path = await makeFile("note.mp3", 10);
    const result = await resolveMediaAttachments([path], "image");
    expect(result.attachments).toEqual([]);
    expect(result.errors[0]).toContain("audio file was given for image analysis");
  });

  it("reports missing files as errors instead of silently analyzing less", async () => {
    const result = await resolveMediaAttachments(["/definitely/not/here.png"], "image");
    expect(result.attachments).toEqual([]);
    expect(result.errors[0]).toContain("file not found");
  });

  it("rejects unsupported extensions", async () => {
    const path = await makeFile("blob.bin", 10);
    const result = await resolveMediaAttachments([path], "video");
    expect(result.errors[0]).toContain("not a supported media file");
  });

  it("enforces the per-modality byte cap", async () => {
    const path = await makeFile("huge.png", 6 * 1024 * 1024);
    const result = await resolveMediaAttachments([path], "image");
    expect(result.attachments).toEqual([]);
    expect(result.errors[0]).toContain("per-image limit");
  }, 20_000);

  it("deduplicates repeated paths and caps the batch at eight", async () => {
    const path = await makeFile("shot.png", 10);
    const duplicated = [path, path];
    const once = await resolveMediaAttachments(duplicated, "image");
    expect(once.attachments).toHaveLength(1);

    const nine = Array.from({ length: 9 }, (_, index) => join(directory, `nine-${index}.png`));
    const tooMany = await resolveMediaAttachments(nine, "image");
    expect(tooMany.attachments).toEqual([]);
    expect(tooMany.errors[0]).toContain("at most 8");
  });
});
