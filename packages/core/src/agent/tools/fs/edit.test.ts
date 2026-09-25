/**
 * Exercises the read_file → edit_file snapshot contract through the real filesystem.
 * In particular, approval and execution must both reject a stale read, and two
 * agents executing against one snapshot must not silently overwrite each other.
 */

import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createEditFileTools } from "./edit";
import { createReadFileTool } from "./read";
import { runTool } from "./test-helpers";

describe("read-bound edit_file", () => {
  const directories: string[] = [];
  const read = createReadFileTool();
  const edit = createEditFileTools();

  function fixture(content = "first\nsecond\nthird\n") {
    const directory = mkdtempSync(join(tmpdir(), "jazz-edit-snapshot-"));
    directories.push(directory);
    const path = join(directory, "sample.txt");
    writeFileSync(path, content);
    return { directory, path };
  }

  async function snapshot(path: string, directory: string, startLine?: number) {
    const result = await runTool(
      read,
      { path, ...(startLine === undefined ? {} : { startLine, endLine: startLine }) },
      directory,
    );
    expect(result.success).toBe(true);
    return (result.result as { snapshot: string }).snapshot;
  }

  function args(path: string, version: string) {
    return {
      path,
      snapshot: version,
      edits: [{ type: "replace_lines", startLine: 2, endLine: 2, content: "updated" }],
    };
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns the same full-file snapshot for partial and full reads", async () => {
    const { directory, path } = fixture();
    expect(await snapshot(path, directory, 2)).toBe(await snapshot(path, directory));
  });

  it("previews and executes an edit against the read file", async () => {
    const { directory, path } = fixture();
    const input = args(path, await snapshot(path, directory));
    const proposal = await runTool(edit.approval, input, directory);
    expect(proposal.result).toMatchObject({ approvalRequired: true });
    expect((proposal.result as { previewDiff: string }).previewDiff).toContain("updated");

    const execution = await runTool(edit.execute, input, directory);
    expect(execution.success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("first\nupdated\nthird\n");
  });

  it("rejects a stale read before asking for approval", async () => {
    const { directory, path } = fixture();
    const input = args(path, await snapshot(path, directory, 2));
    writeFileSync(path, "inserted\nfirst\nsecond\nthird\n");

    const proposal = await runTool(edit.approval, input, directory);
    expect(proposal.result).toMatchObject({ errorType: "StaleFileError" });
    expect(proposal.error).toContain("Read the file again");
    expect(readFileSync(path, "utf8")).toContain("inserted");
  });

  it("rejects a change made while approval is pending", async () => {
    const { directory, path } = fixture();
    const input = args(path, await snapshot(path, directory));
    expect((await runTool(edit.approval, input, directory)).result).toMatchObject({
      approvalRequired: true,
    });
    writeFileSync(path, "first\nother agent's edit\nthird\n");

    const execution = await runTool(edit.execute, input, directory);
    expect(execution.result).toMatchObject({ errorType: "StaleFileError" });
    expect(readFileSync(path, "utf8")).toBe("first\nother agent's edit\nthird\n");
  });

  it("allows only one of two concurrent agents to spend the same snapshot", async () => {
    const { directory, path } = fixture();
    const version = await snapshot(path, directory);
    const [first, second] = await Promise.all([
      runTool(edit.execute, args(path, version), directory),
      runTool(
        edit.execute,
        {
          ...args(path, version),
          edits: [{ type: "replace_lines", startLine: 2, endLine: 2, content: "rival" }],
        },
        directory,
      ),
    ]);

    expect([first.success, second.success].sort()).toEqual([false, true]);
    expect([first.result, second.result]).toContainEqual({ errorType: "StaleFileError", path });
    expect(["first\nupdated\nthird\n", "first\nrival\nthird\n"]).toContain(
      readFileSync(path, "utf8"),
    );
  });

  it("binds the snapshot to the canonical target, including symlink aliases", async () => {
    const { directory, path } = fixture();
    const alias = join(directory, "alias.txt");
    symlinkSync(path, alias);
    const version = await snapshot(alias, directory);
    const execution = await runTool(edit.execute, args(path, version), directory);
    expect(execution.success).toBe(true);
  });

  it("does not accept an identical file at a different path", async () => {
    const { directory, path } = fixture();
    const other = join(directory, "other.txt");
    writeFileSync(other, readFileSync(path));
    const version = await snapshot(path, directory);

    const execution = await runTool(edit.execute, args(other, version), directory);
    expect(execution.result).toMatchObject({ errorType: "StaleFileError" });
    expect(readFileSync(other, "utf8")).toBe("first\nsecond\nthird\n");
  });
});
