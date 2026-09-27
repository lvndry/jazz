import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { inlineMentionedTextFiles, MAX_INLINED_FILE_BYTES } from "./mentioned-files";

const workingDirectory = mkdtempSync(path.join(tmpdir(), "jazz-mentions-"));
writeFileSync(path.join(workingDirectory, "todo.md"), "- buy milk\n");
writeFileSync(path.join(workingDirectory, "my notes.txt"), "call the bank");
writeFileSync(path.join(workingDirectory, "blob.bin"), Buffer.from([0x50, 0x00, 0x4b]));
writeFileSync(path.join(workingDirectory, "huge.log"), "x".repeat(MAX_INLINED_FILE_BYTES + 1));
writeFileSync(path.join(workingDirectory, "shot.png"), "not really a png");

afterAll(() => {
  rmSync(workingDirectory, { recursive: true, force: true });
});

describe("inlineMentionedTextFiles", () => {
  it("appends an @-mentioned text file to the message", async () => {
    const result = await inlineMentionedTextFiles("what is left on @todo.md?", workingDirectory);
    expect(result.message).toStartWith("what is left on @todo.md?\n\n<file path=");
    expect(result.message).toContain("- buy milk");
    expect(result.skipped).toEqual([]);
  });

  it("reads quoted and escaped paths with spaces", async () => {
    const quoted = await inlineMentionedTextFiles('see @"my notes.txt"', workingDirectory);
    const escaped = await inlineMentionedTextFiles("see @my\\ notes.txt", workingDirectory);
    expect(quoted.message).toContain("call the bank");
    expect(escaped.message).toContain("call the bank");
  });

  it("leaves a bare path, a missing file and a media file to other paths", async () => {
    const message = `${path.join(workingDirectory, "todo.md")} and @nope.md and @shot.png`;
    const result = await inlineMentionedTextFiles(message, workingDirectory);
    expect(result).toEqual({ message, skipped: [] });
  });

  it("reports a binary or oversized file instead of inlining it", async () => {
    const result = await inlineMentionedTextFiles("@blob.bin @huge.log", workingDirectory);
    expect(result.message).toBe("@blob.bin @huge.log");
    expect(result.skipped).toHaveLength(2);
  });

  it("inlines a file mentioned twice once", async () => {
    const result = await inlineMentionedTextFiles("@todo.md vs @todo.md", workingDirectory);
    expect(result.message.match(/<file /g)).toHaveLength(1);
  });
});
