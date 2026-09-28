import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCpTools } from "./cp";
import { createMvTools } from "./mv";
import { createRmTools } from "./rm";
import { runTool } from "./test-helpers";

describe("file tools changing Jazz's own state", () => {
  let root: string;
  let jazzHome: string;
  const savedHome = process.env["JAZZ_HOME"];
  const savedConfigPath = process.env["JAZZ_CONFIG_PATH"];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "jazz-state-tools-")));
    jazzHome = join(root, "home");
    mkdirSync(join(jazzHome, "skills"), { recursive: true });
    writeFileSync(join(jazzHome, "config.json"), "{}\n");
    writeFileSync(join(root, "notes.txt"), "notes\n");
    process.env["JAZZ_HOME"] = jazzHome;
    delete process.env["JAZZ_CONFIG_PATH"];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = savedHome;
    }
    if (savedConfigPath !== undefined) {
      process.env["JAZZ_CONFIG_PATH"] = savedConfigPath;
    }
  });

  async function approval(tool: { approval: Parameters<typeof runTool>[0] }, args: object) {
    return (await runTool(tool.approval, args as Record<string, unknown>, root)).result;
  }

  it("always asks for rm, mv and cp that change config or state", async () => {
    const config = join(jazzHome, "config.json");
    const cases = [
      [createRmTools(), { path: config }],
      [createRmTools(), { path: jazzHome, recursive: true }],
      [createMvTools(), { source: config, destination: join(root, "moved.json") }],
      [createMvTools(), { source: join(root, "notes.txt"), destination: config, force: true }],
      [createCpTools(), { source: join(root, "notes.txt"), destination: config, force: true }],
    ] as const;
    for (const [tool, args] of cases) {
      expect(await approval(tool, args)).toMatchObject({ approvalRequired: true, alwaysAsk: true });
    }
  });

  it("follows the ordinary policy for authored content and other files", async () => {
    const cases = [
      [createRmTools(), { path: join(root, "notes.txt") }],
      [createCpTools(), { source: join(jazzHome, "config.json"), destination: join(root, "c") }],
      [
        createCpTools(),
        { source: join(root, "notes.txt"), destination: join(jazzHome, "skills", "n.md") },
      ],
    ] as const;
    for (const [tool, args] of cases) {
      const result = await approval(tool, args);
      expect(result).toMatchObject({ approvalRequired: true });
      expect(result).not.toHaveProperty("alwaysAsk");
    }
  });
});
