import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createLsTool } from "./ls";
import { runTool } from "./test-helpers";

describe("ls tool", () => {
  const testDir = join(tmpdir(), `jazz-ls-test-${Date.now()}`);
  const tool = createLsTool();

  beforeAll(() => {
    // Create test directory tree:
    // testDir/
    //   alpha.ts
    //   beta.js
    //   .dotfile
    //   child/
    //     gamma.ts
    //     grandchild/
    //       delta.ts
    mkdirSync(join(testDir, "child", "grandchild"), { recursive: true });
    writeFileSync(join(testDir, "alpha.ts"), "const a = 1;\n");
    writeFileSync(join(testDir, "beta.js"), "const b = 2;\n");
    writeFileSync(join(testDir, ".dotfile"), "hidden\n");
    writeFileSync(join(testDir, "child", "gamma.ts"), "const g = 3;\n");
    writeFileSync(join(testDir, "child", "grandchild", "delta.ts"), "const d = 4;\n");
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // Tool structure
  // ---------------------------------------------------------------

  it("should have correct name and description", () => {
    expect(tool.name).toBe("ls");
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20);
  });

  // ---------------------------------------------------------------
  // Non-recursive (default)
  // ---------------------------------------------------------------

  it("should list top-level files and directories", async () => {
    const result = await runTool(tool, { path: testDir }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string; type: string }>;
    expect(items.some((i) => i.name === "alpha.ts" && i.type === "file")).toBe(true);
    expect(items.some((i) => i.name === "beta.js" && i.type === "file")).toBe(true);
    expect(items.some((i) => i.name === "child" && i.type === "dir")).toBe(true);
  });

  it("should not include nested files when non-recursive", async () => {
    const result = await runTool(tool, { path: testDir }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.every((i) => i.name !== "gamma.ts")).toBe(true);
    expect(items.every((i) => i.name !== "delta.ts")).toBe(true);
  });

  it("should hide dotfiles by default", async () => {
    const result = await runTool(tool, { path: testDir }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.every((i) => !i.name.startsWith("."))).toBe(true);
  });

  it("should show dotfiles when showHidden is true", async () => {
    const result = await runTool(tool, { path: testDir, showHidden: true }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.some((i) => i.name === ".dotfile")).toBe(true);
  });

  // ---------------------------------------------------------------
  // Recursive
  // ---------------------------------------------------------------

  it("should list nested files when recursive", async () => {
    const result = await runTool(tool, { path: testDir, recursive: true }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.some((i) => i.name === "gamma.ts")).toBe(true);
    expect(items.some((i) => i.name === "delta.ts")).toBe(true);
  });

  it("should respect maxDepth when recursive", async () => {
    const result = await runTool(tool, { path: testDir, recursive: true, maxDepth: 1 }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ path: string }>;
    // maxDepth 1 = only immediate children, no grandchild/delta.ts
    expect(items.every((i) => !i.path.includes("grandchild"))).toBe(true);
  });

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------

  it("should filter by substring pattern", async () => {
    const result = await runTool(
      tool,
      { path: testDir, recursive: true, pattern: "alpha" },
      testDir,
    );
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => i.name.includes("alpha"))).toBe(true);
  });

  it("should filter by regex pattern", async () => {
    const result = await runTool(
      tool,
      { path: testDir, recursive: true, pattern: "re:\\.ts$" },
      testDir,
    );
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => i.name.endsWith(".ts"))).toBe(true);
  });

  // ---------------------------------------------------------------
  // maxResults
  // ---------------------------------------------------------------

  it("should respect maxResults", async () => {
    const result = await runTool(tool, { path: testDir, recursive: true, maxResults: 2 }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ path: string }>;
    expect(items.length).toBeLessThanOrEqual(2);
  });

  // ---------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------

  it("should fail for non-existent path", async () => {
    const result = await runTool(tool, { path: "/tmp/nonexistent-ls-test-xyz" }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("should fail when path is a file, not a directory", async () => {
    const result = await runTool(tool, { path: join(testDir, "alpha.ts") }, testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not a directory");
  });

  // ---------------------------------------------------------------
  // Uses cwd when path is omitted
  // ---------------------------------------------------------------

  it("should use cwd when path is omitted", async () => {
    const result = await runTool(tool, {}, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.some((i) => i.name === "alpha.ts")).toBe(true);
  });
});
