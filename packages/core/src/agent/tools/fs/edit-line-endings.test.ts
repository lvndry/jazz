import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createEditFileTools, type EditOperation } from "./edit";
import { createReadFileTool } from "./read";
import { runTool } from "./test-helpers";

const BOM = "﻿";

describe("edit_file keeps the file's line endings and BOM", () => {
  const directories: string[] = [];
  const read = createReadFileTool();
  const edit = createEditFileTools();

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function applyEdits(content: string, edits: EditOperation[]) {
    const directory = mkdtempSync(join(tmpdir(), "jazz-edit-eol-"));
    directories.push(directory);
    const path = join(directory, "sample.txt");
    writeFileSync(path, content);
    const readResult = await runTool(read, { path }, directory);
    const snapshot = (readResult.result as { snapshot: string }).snapshot;
    const approval = await runTool(edit.approval, { path, snapshot, edits }, directory);
    expect(approval.result).toMatchObject({ approvalRequired: true });
    const execution = await runTool(edit.execute, { path, snapshot, edits }, directory);
    expect(execution.success).toBe(true);
    return readFileSync(path, "utf8");
  }

  it("writes replace_lines content with CRLF into a CRLF file", async () => {
    const result = await applyEdits("a\r\nb\r\nc\r\n", [
      { type: "replace_lines", startLine: 2, endLine: 2, content: "x\ny" },
    ]);
    expect(result).toBe("a\r\nx\r\ny\r\nc\r\n");
  });

  it("writes insert content with CRLF into a CRLF file", async () => {
    const result = await applyEdits("a\r\nb\r\n", [{ type: "insert", line: 1, content: "x\ny" }]);
    expect(result).toBe("a\r\nx\r\ny\r\nb\r\n");
  });

  it("keeps CRLF when deleting lines", async () => {
    const result = await applyEdits("a\r\nb\r\nc\r\n", [
      { type: "delete_lines", startLine: 2, endLine: 2 },
    ]);
    expect(result).toBe("a\r\nc\r\n");
  });

  it("replaces a literal pattern without touching the line endings", async () => {
    const result = await applyEdits("foo bar\r\nbaz\r\n", [
      { type: "replace_pattern", pattern: "bar", replacement: "qux" },
    ]);
    expect(result).toBe("foo qux\r\nbaz\r\n");
  });

  it("keeps the BOM when line 1 is replaced", async () => {
    const result = await applyEdits(`${BOM}a\nb\n`, [
      { type: "replace_lines", startLine: 1, endLine: 1, content: "x" },
    ]);
    expect(result).toBe(`${BOM}x\nb\n`);
  });

  it("keeps both the BOM and CRLF", async () => {
    const result = await applyEdits(`${BOM}a\r\nb\r\n`, [
      { type: "insert", line: 0, content: "first" },
    ]);
    expect(result).toBe(`${BOM}first\r\na\r\nb\r\n`);
  });

  it("uses the dominant ending of a mixed file", async () => {
    const result = await applyEdits("a\r\nb\r\nc\nd\r\n", [
      { type: "insert", line: 4, content: "e" },
    ]);
    expect(result).toBe("a\r\nb\r\nc\r\nd\r\ne\r\n");
  });

  it("keeps an LF file with no BOM as it is", async () => {
    const result = await applyEdits("a\nb\n", [{ type: "insert", line: 1, content: "x" }]);
    expect(result).toBe("a\nx\nb\n");
  });
});
