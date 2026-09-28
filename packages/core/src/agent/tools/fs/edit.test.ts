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

  it("refuses an edit that would write a redaction placeholder over a secret", async () => {
    const { directory, path } = fixture("DEBUG=1\nAPI_TOKEN=real-value\n");
    const input = {
      path,
      snapshot: await snapshot(path, directory),
      edits: [
        {
          type: "replace_lines",
          startLine: 1,
          endLine: 2,
          content: "DEBUG=0\nAPI_TOKEN=[redacted:API_TOKEN]",
        },
      ],
    };
    for (const half of [edit.approval, edit.execute]) {
      await expect(runTool(half, input, directory)).rejects.toThrow(
        "edits[0].content carries [redacted:API_TOKEN]",
      );
    }
    expect(readFileSync(path, "utf8")).toBe("DEBUG=1\nAPI_TOKEN=real-value\n");
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

  it("matches patterns against the redacted view, so a secret value cannot be probed", async () => {
    const { directory, path } = fixture("DEBUG=1\nDB_PASSWORD=hunter2hunter2\nPORT=3000\n");
    const version = await snapshot(path, directory);
    const replace = (pattern: string) => ({
      path,
      snapshot: version,
      edits: [{ type: "replace_pattern", pattern, replacement: "x" }],
    });

    const rightGuess = await runTool(edit.approval, replace("re:^DB_PASSWORD=h"), directory);
    const wrongGuess = await runTool(edit.approval, replace("re:^DB_PASSWORD=z"), directory);
    const valueGuess = await runTool(edit.approval, replace("hunter2"), directory);
    for (const result of [rightGuess, wrongGuess, valueGuess]) {
      expect(result.result).toMatchObject({ errorType: "PatternNotFoundError" });
    }

    const onSecretLine = await runTool(edit.approval, replace("DB_PASSWORD="), directory);
    expect(onSecretLine.result).toMatchObject({ errorType: "SecretLineMatchError" });
    expect(readFileSync(path, "utf8")).toBe("DEBUG=1\nDB_PASSWORD=hunter2hunter2\nPORT=3000\n");
  });

  it("edits the lines around a secret and keeps the secret line exactly", async () => {
    const { directory, path } = fixture("DEBUG=1\nDB_PASSWORD=hunter2hunter2\nPORT=3000\n");
    const input = {
      path,
      snapshot: await snapshot(path, directory),
      edits: [
        { type: "replace_pattern", pattern: "DEBUG=1", replacement: "# debug\nDEBUG=0" },
        { type: "replace_pattern", pattern: "PORT=3000", replacement: "PORT=4000" },
      ],
    };
    expect((await runTool(edit.approval, input, directory)).result).toMatchObject({
      approvalRequired: true,
    });
    expect((await runTool(edit.execute, input, directory)).success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      "# debug\nDEBUG=0\nDB_PASSWORD=hunter2hunter2\nPORT=4000\n",
    );
  });

  it("writes placeholder-shaped text that stands for no secret of the file", async () => {
    const { directory, path } = fixture("# Redaction\n");
    const input = {
      path,
      snapshot: await snapshot(path, directory),
      edits: [{ type: "insert", line: 1, content: "Secrets appear as [redacted:<name>]." }],
    };
    expect((await runTool(edit.execute, input, directory)).success).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("# Redaction\nSecrets appear as [redacted:<name>].\n");
  });

  it("always asks before editing Jazz's config", async () => {
    const { directory } = fixture();
    const savedHome = process.env["JAZZ_HOME"];
    const savedConfigPath = process.env["JAZZ_CONFIG_PATH"];
    process.env["JAZZ_HOME"] = directory;
    delete process.env["JAZZ_CONFIG_PATH"];
    try {
      const path = join(directory, "config.json");
      writeFileSync(path, '{\n  "autoApprovedCommands": []\n}\n');
      const input = {
        path,
        snapshot: await snapshot(path, directory),
        edits: [{ type: "replace_lines", startLine: 2, endLine: 2, content: '  "x": 1' }],
      };
      expect((await runTool(edit.approval, input, directory)).result).toMatchObject({
        approvalRequired: true,
        alwaysAsk: true,
      });
    } finally {
      if (savedHome === undefined) {
        delete process.env["JAZZ_HOME"];
      } else {
        process.env["JAZZ_HOME"] = savedHome;
      }
      if (savedConfigPath !== undefined) {
        process.env["JAZZ_CONFIG_PATH"] = savedConfigPath;
      }
    }
  });
});
