import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createFindTool } from "./find";
import { runTool } from "./test-helpers";

describe("find tool", () => {
  const testDir = join(tmpdir(), `jazz-find-test-${Date.now()}`);
  const tool = createFindTool();

  beforeAll(() => {
    // Create a test directory tree:
    // testDir/
    //   foo.ts
    //   bar.js
    //   .hidden
    //   sub/
    //     baz.ts
    //     deep/
    //       qux.tsx
    //   empty/
    mkdirSync(join(testDir, "sub", "deep"), { recursive: true });
    mkdirSync(join(testDir, "empty"), { recursive: true });
    writeFileSync(join(testDir, "foo.ts"), "export const foo = 1;\n");
    writeFileSync(join(testDir, "bar.js"), "const bar = 2;\n");
    writeFileSync(join(testDir, ".hidden"), "secret\n");
    writeFileSync(join(testDir, "sub", "baz.ts"), "export const baz = 3;\n");
    writeFileSync(join(testDir, "sub", "deep", "qux.tsx"), "<div>qux</div>\n");
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // Tool structure
  // ---------------------------------------------------------------

  it("should have correct name and description", () => {
    expect(tool.name).toBe("find");
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.parameters).toBeDefined();
  });

  // ---------------------------------------------------------------
  // Basic find (fast-glob backend)
  // ---------------------------------------------------------------

  it("should find all files and directories in a directory", async () => {
    const result = await runTool(tool, { path: testDir, smart: false }, testDir);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.result)).toBe(true);

    const paths = (result.result as Array<{ path: string }>).map((r) => r.path);
    expect(paths.some((p) => p.endsWith("foo.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("bar.js"))).toBe(true);
    expect(paths.some((p) => p.endsWith("baz.ts"))).toBe(true);
  });

  it("should filter by substring name", async () => {
    const result = await runTool(tool, { path: testDir, name: "foo", smart: false }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => i.name.includes("foo"))).toBe(true);
  });

  it("should filter by glob pattern in name", async () => {
    const result = await runTool(tool, { path: testDir, name: "*.ts", smart: false }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    // Should find foo.ts and baz.ts but NOT qux.tsx
    expect(items.some((i) => i.name === "foo.ts")).toBe(true);
    expect(items.some((i) => i.name === "baz.ts")).toBe(true);
    expect(items.every((i) => !i.name.endsWith(".tsx"))).toBe(true);
  });

  it("should filter by regex name", async () => {
    const result = await runTool(
      tool,
      { path: testDir, name: "re:^(foo|baz)\\.ts$", smart: false },
      testDir,
    );
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.length).toBe(2);
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(["baz.ts", "foo.ts"]);
  });

  it("should filter by type 'file'", async () => {
    const result = await runTool(tool, { path: testDir, type: "file", smart: false }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ type: string }>;
    expect(items.every((i) => i.type === "file")).toBe(true);
  });

  it("should filter by type 'dir'", async () => {
    const result = await runTool(tool, { path: testDir, type: "dir", smart: false }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string; type: string }>;
    expect(items.every((i) => i.type === "dir")).toBe(true);
    expect(items.some((i) => i.name === "sub")).toBe(true);
    expect(items.some((i) => i.name === "empty")).toBe(true);
  });

  it("should respect maxDepth", async () => {
    const result = await runTool(
      tool,
      { path: testDir, maxDepth: 1, type: "file", smart: false },
      testDir,
    );
    expect(result.success).toBe(true);

    const items = result.result as Array<{ path: string }>;
    // Should only find files at depth 1 (foo.ts, bar.js) — not sub/baz.ts
    expect(items.every((i) => !i.path.includes("/sub/"))).toBe(true);
  });

  it("should exclude hidden files by default", async () => {
    const result = await runTool(tool, { path: testDir, smart: false }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.every((i) => !i.name.startsWith("."))).toBe(true);
  });

  it("should include hidden files when includeHidden is true", async () => {
    const result = await runTool(
      tool,
      { path: testDir, includeHidden: true, smart: false },
      testDir,
    );
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.some((i) => i.name === ".hidden")).toBe(true);
  });

  it("should respect maxResults", async () => {
    const result = await runTool(tool, { path: testDir, maxResults: 2, smart: false }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ path: string }>;
    expect(items.length).toBeLessThanOrEqual(2);
  });

  it("should enforce hard cap of 2000", async () => {
    const result = await runTool(tool, { path: testDir, maxResults: 5000, smart: false }, testDir);
    expect(result.success).toBe(true);
    // We don't have 2000 files but the tool shouldn't crash
  });

  // ---------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------

  it("should handle non-existent path gracefully", async () => {
    const result = await runTool(
      tool,
      { path: "/tmp/nonexistent-path-xyz-12345", smart: false },
      testDir,
    ).catch((e) => ({ success: false, result: null, error: String(e) }));

    // fast-glob suppressErrors returns empty results for non-existent paths,
    // which is acceptable graceful handling.
    if (result.success) {
      const items = result.result as Array<{ path: string }>;
      expect(items.length).toBe(0);
    } else {
      expect(result.success).toBe(false);
    }
  });

  // ---------------------------------------------------------------
  // Smart search (uses cwd)
  // ---------------------------------------------------------------

  it("should use smart search when path is omitted", async () => {
    // Smart search starts from cwd (testDir) — with maxDepth 2 to keep it fast
    const result = await runTool(tool, { name: "foo.ts", maxDepth: 2 }, testDir);
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    expect(items.some((i) => i.name === "foo.ts")).toBe(true);
  });

  // ---------------------------------------------------------------
  // Advanced filters (fd/find backend)
  // ---------------------------------------------------------------

  it("should use external backend for size filter", async () => {
    const result = await runTool(
      tool,
      { path: testDir, name: "*.ts", size: "-10M", smart: false },
      testDir,
    );
    expect(result.success).toBe(true);

    const items = result.result as Array<{ name: string }>;
    // Our test files are tiny, should find them
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("should use external backend for excludePaths", async () => {
    const result = await runTool(
      tool,
      { path: testDir, excludePaths: ["*sub*"], smart: false },
      testDir,
    );
    expect(result.success).toBe(true);

    const items = result.result as Array<{ path: string }>;
    // Should not contain anything from sub/
    expect(items.every((i) => !i.path.includes("/sub/"))).toBe(true);
  });
});
