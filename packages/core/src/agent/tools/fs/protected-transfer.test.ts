/** Whole-file credential transfer tests assert bytes on disk and absence from every tool result. */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getProtectedFilesRegistryPath } from "@/core/utils/protected-files";
import { createCpTools } from "./cp";
import { createEditFileTools } from "./edit";
import { createGrepTool } from "./grep";
import { createMvTools } from "./mv";
import { createReadFileTool } from "./read";
import { createRmTools } from "./rm";
import { runTool as executeTool } from "./test-helpers";
import { createWriteFileTools } from "./write";

/** The executor converts typed tool failures to results; inspect that same failure surface here. */
const runTool: typeof executeTool = async (...args) => {
  try {
    return await executeTool(...args);
  } catch (error) {
    return { success: false, result: null, error: String(error) };
  }
};

const SECRET = "TOKEN=never-include-this-value";
let root: string;
let savedHome: string | undefined;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-transfer-test-")));
  savedHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = path.join(root, "jazz");
  fs.mkdirSync(path.join(root, "jazz"));
  fs.writeFileSync(path.join(root, ".env"), SECRET);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

async function readProtected(file: string): Promise<void> {
  const result = await runTool(createReadFileTool(), { path: file }, root);
  expect(result.success).toBe(true);
  expect(result.result).toMatchObject({ protected: true, contentOmitted: true });
  expect(JSON.stringify(result)).not.toContain(SECRET);
}

describe("protected transfers", () => {
  it("proposes with paths only, copies exact bytes privately, and protects renamed copies", async () => {
    const cp = createCpTools();
    const args = { source: ".env", destination: "backup.txt" };
    const proposal = await runTool(cp.approval, args, root);
    expect(JSON.stringify(proposal)).not.toContain(SECRET);
    expect(fs.existsSync(path.join(root, "backup.txt"))).toBe(false);
    const result = await runTool(cp.execute, args, root);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(root, "backup.txt"), "utf8")).toBe(SECRET);
    expect(fs.statSync(path.join(root, "backup.txt")).mode & 0o777).toBe(0o600);
    await readProtected("backup.txt");
    const search = await runTool(createGrepTool(), { path: root, pattern: "TOKEN" }, root);
    expect(JSON.stringify(search)).not.toContain("never-include-this-value");
    const moved = await runTool(
      createMvTools().execute,
      { source: "backup.txt", destination: "renamed.txt" },
      root,
    );
    expect(moved.success).toBe(true);
    await readProtected("renamed.txt");
  });

  it("protects directory copies containing .env and directories moved with tracked descendants", async () => {
    fs.mkdirSync(path.join(root, "source"));
    fs.writeFileSync(path.join(root, "source", ".env.local"), SECRET);
    const copied = await runTool(
      createCpTools().execute,
      { source: "source", destination: "copy" },
      root,
    );
    expect(copied.success).toBe(true);
    expect(fs.statSync(path.join(root, "copy")).mode & 0o777).toBe(0o700);
    await readProtected("copy/.env.local");
    fs.renameSync(path.join(root, "copy", ".env.local"), path.join(root, "copy", "ordinary.txt"));
    await readProtected("copy/ordinary.txt");
    const moved = await runTool(
      createMvTools().execute,
      { source: "copy", destination: "moved" },
      root,
    );
    expect(moved.success).toBe(true);
    await readProtected("moved/ordinary.txt");
  });

  it("propagates protection when moving an ordinary parent of a tracked file", async () => {
    fs.mkdirSync(path.join(root, "parent"));
    expect(
      (await runTool(createCpTools().execute, { source: ".env", destination: "parent/data" }, root))
        .success,
    ).toBe(true);
    expect(
      (await runTool(createMvTools().execute, { source: "parent", destination: "relocated" }, root))
        .success,
    ).toBe(true);
    await readProtected("relocated/data");
    expect(
      (
        await runTool(
          createCpTools().execute,
          { source: "relocated/data", destination: "another" },
          root,
        )
      ).success,
    ).toBe(true);
    await readProtected("another");
  });

  it("keeps protection through symlinked source and destination parent paths", async () => {
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "alias"));
    fs.mkdirSync(path.join(root, "real"));
    fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"));
    const result = await runTool(
      createCpTools().execute,
      { source: "alias", destination: "linked/data" },
      root,
    );
    expect(result.success).toBe(true);
    await readProtected("real/data");
    expect(fs.readFileSync(path.join(root, "real/data"), "utf8")).toBe(SECRET);
  });

  it("never exposes protected bytes in write or edit preview errors", async () => {
    for (const tool of createWriteFileTools().all()) {
      const result = await runTool(tool, { path: ".env", content: "replacement" }, root);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    for (const tool of createEditFileTools().all()) {
      const result = await runTool(
        tool,
        {
          path: ".env",
          snapshot: `sha256:${"0".repeat(64)}`,
          edits: [{ type: "replace_pattern", pattern: "TOKEN", replacement: "OTHER" }],
        },
        root,
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe(SECRET);
  });

  it("refuses registry deletion and ancestor replacement, and fails closed on corruption", async () => {
    await runTool(createCpTools().execute, { source: ".env", destination: "backup" }, root);
    const registry = getProtectedFilesRegistryPath();
    const removed = await runTool(createRmTools().execute, { path: registry, force: true }, root);
    expect(removed.success).toBe(false);
    const parent = await runTool(
      createRmTools().execute,
      { path: path.dirname(registry), recursive: true, force: true },
      root,
    );
    expect(parent.success).toBe(false);
    fs.writeFileSync(registry, "corrupt");
    await readProtected("backup");
    const copy = await runTool(
      createCpTools().execute,
      { source: ".env", destination: "new-backup" },
      root,
    );
    expect(copy.success).toBe(false);
    expect(fs.existsSync(path.join(root, "new-backup"))).toBe(false);
  });

  it("leaves ordinary copies readable", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), "ordinary text");
    const copied = await runTool(
      createCpTools().execute,
      { source: "notes.txt", destination: "notes-copy.txt" },
      root,
    );
    expect(copied.success).toBe(true);
    const read = await runTool(createReadFileTool(), { path: "notes-copy.txt" }, root);
    expect(JSON.stringify(read)).toContain("ordinary text");
  });
});
