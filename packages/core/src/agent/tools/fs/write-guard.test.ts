import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { runTool } from "./test-helpers";
import { createWriteFileTools } from "./write";

const BOM = "﻿";

describe("write_file overwrite guard", () => {
  const directories: string[] = [];
  const write = createWriteFileTools();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(content?: string) {
    const directory = mkdtempSync(join(tmpdir(), "jazz-write-guard-"));
    directories.push(directory);
    const path = join(directory, "sample.txt");
    if (content !== undefined) {
      writeFileSync(path, content);
    }
    return { directory, path };
  }

  it("refuses to overwrite a file that changed after the approval was shown", async () => {
    const { directory, path } = fixture("original\n");
    const input = { path, content: "rewritten\n" };
    expect((await runTool(write.approval, input, directory)).result).toMatchObject({
      approvalRequired: true,
    });
    writeFileSync(path, "another agent's work\n");

    const execution = await runTool(write.execute, input, directory);

    expect(execution.success).toBe(false);
    expect(execution.result).toMatchObject({ errorType: "StaleFileError" });
    expect(execution.error).toContain("Read the file again");
    expect(readFileSync(path, "utf8")).toBe("another agent's work\n");
  });

  it("refuses to create a file another writer created after the approval was shown", async () => {
    const { directory, path } = fixture();
    const input = { path, content: "mine\n" };
    await runTool(write.approval, input, directory);
    writeFileSync(path, "theirs\n");

    const execution = await runTool(write.execute, input, directory);

    expect(execution.result).toMatchObject({ errorType: "StaleFileError" });
    expect(readFileSync(path, "utf8")).toBe("theirs\n");
  });

  it("overwrites an unchanged file once approved, and the approval is spent", async () => {
    const { directory, path } = fixture("original\n");
    const input = { path, content: "rewritten\n" };
    await runTool(write.approval, input, directory);

    expect((await runTool(write.execute, input, directory)).success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("rewritten\n");

    writeFileSync(path, "edited later\n");
    expect((await runTool(write.execute, input, directory)).success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("rewritten\n");
  });

  it("creates a new file without any prior approval or read", async () => {
    const { directory, path } = fixture();
    expect((await runTool(write.execute, { path, content: "new\n" }, directory)).success).toBe(
      true,
    );
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });

  it("writes LF content with the CRLF endings and BOM of the file it replaces", async () => {
    const { directory, path } = fixture(`${BOM}a\r\nb\r\n`);
    const execution = await runTool(write.execute, { path, content: "x\ny\nz\n" }, directory);
    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${BOM}x\r\ny\r\nz\r\n`);
  });

  it("writes content that carries its own CRLF unchanged", async () => {
    const { directory, path } = fixture("a\nb\n");
    await runTool(write.execute, { path, content: "x\r\ny\r\n" }, directory);
    expect(readFileSync(path, "utf8")).toBe("x\r\ny\r\n");
  });
});
