import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { MAX_ATTACHMENT_BYTES, type MessageAttachment } from "@/core/types/attachment";
import type { ToolExecutionContext } from "@/core/types/tools";
import { attachMediaFile } from "./attach-media";

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

function makeContext(
  kinds: MessageAttachment["kind"][],
  collected: MessageAttachment[],
): ToolExecutionContext {
  return {
    agentId: "test",
    supportedAttachmentKinds: kinds,
    attachMedia: (attachment) => collected.push(attachment),
  } as ToolExecutionContext;
}

async function tempPng(name = "shot.png", bytes = pngBytes()): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jazz-attach-media-"));
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

describe("attachMediaFile", () => {
  it("passes through non-media files so text reading is unaffected", async () => {
    const outcome = await attachMediaFile("/some/file.ts", makeContext(["image"], []));
    expect(outcome.kind).toBe("not-media");
  });

  it("attaches an image and reports the probed shape", async () => {
    const collected: MessageAttachment[] = [];
    const path = await tempPng("shot.png", pngBytes(640, 480));

    const outcome = await attachMediaFile(path, makeContext(["image"], collected));
    expect(outcome.kind).toBe("attached");
    expect(collected).toHaveLength(1);
    expect(collected[0]?.width).toBe(640);
    expect(collected[0]?.height).toBe(480);
    expect(collected[0]?.mediaType).toBe("image/png");
  });

  it("fails loudly when the model has no input for that modality", async () => {
    const collected: MessageAttachment[] = [];
    const path = await tempPng();

    const outcome = await attachMediaFile(path, makeContext([], collected));
    expect(outcome.kind).toBe("failed");
    expect(collected).toHaveLength(0);
    if (outcome.kind === "failed") {
      // Instructing the model not to guess is the point — silence produces invented contents.
      expect(outcome.result.error).toContain("Do not guess");
      expect(outcome.result.success).toBe(false);
    }
  });

  it("points a PDF at read_pdf rather than reporting a dead end", async () => {
    // Text extraction needs no model capability, so the modality gap is not the real obstacle.
    const path = await tempPng("doc.pdf", Buffer.from("%PDF-1.4 fake"));
    const outcome = await attachMediaFile(path, makeContext(["image"], []));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.result.error).toContain("read_pdf");
      expect(outcome.result.error).not.toContain("Do not guess");
    }
  });

  it("fails when the run cannot carry attachments at all", async () => {
    const path = await tempPng();
    const outcome = await attachMediaFile(path, { agentId: "test" } as ToolExecutionContext);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.result.error).toContain("no way to attach media");
    }
  });

  it("rejects a file over its modality's size limit", async () => {
    const collected: MessageAttachment[] = [];
    const path = await tempPng("huge.png", Buffer.alloc(MAX_ATTACHMENT_BYTES.image + 1));

    const outcome = await attachMediaFile(path, makeContext(["image"], collected));
    expect(outcome.kind).toBe("failed");
    expect(collected).toHaveLength(0);
  });

  it("fails on a missing file rather than attaching a path that cannot be read", async () => {
    const outcome = await attachMediaFile("/nonexistent/a.png", makeContext(["image"], []));
    expect(outcome.kind).toBe("failed");
  });
});
