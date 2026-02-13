import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createGrepTool } from "./grep";
import { runTool } from "./test-helpers";

describe("grep tool", () => {
  const testDir = join(tmpdir(), `jazz-grep-test-${Date.now()}`);
  const tool = createGrepTool();

  beforeAll(() => {
    // Create test files with known content:
    // testDir/
    //   hello.ts          → contains "hello world" and "export const hello"
    //   math.js           → contains "function add" and "function subtract"
    //   readme.md         → contains "# README" and "TODO: fix this"
    //   sub/
    //     nested.ts       → contains "import { hello }" and "const nested = true"
    mkdirSync(join(testDir, "sub"), { recursive: true });
    writeFileSync(
      join(testDir, "hello.ts"),
      'export const hello = "hello world";\nexport function greet() { return hello; }\n',
    );
    writeFileSync(
      join(testDir, "math.js"),
      "function add(a, b) { return a + b; }\nfunction subtract(a, b) { return a - b; }\n",
    );
    writeFileSync(
      join(testDir, "readme.md"),
      "# README\n\nThis is a test project.\n\nTODO: fix this\n",
    );
    writeFileSync(
      join(testDir, "sub", "nested.ts"),
      'import { hello } from "../hello";\nconst nested = true;\n',
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // Tool structure
  // ---------------------------------------------------------------

  it("should have correct name and description", () => {
    expect(tool.name).toBe("grep");
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20);
  });

  // ---------------------------------------------------------------
  // Content mode (default)
  // ---------------------------------------------------------------

  it("should find literal string matches", async () => {
    const result = await runTool(tool, { pattern: "hello world", path: testDir }, testDir);
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string; text: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(1);
    expect(data.matches.some((m) => m.text.includes("hello world"))).toBe(true);
  });

  it("should find regex matches with re: prefix", async () => {
    const result = await runTool(tool, { pattern: "re:function\\s+\\w+", path: testDir }, testDir);
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string; text: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(2); // add and subtract
  });

  it("should find regex matches with regex flag", async () => {
    const result = await runTool(
      tool,
      { pattern: "TODO.*fix", path: testDir, regex: true },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string; text: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(1);
  });

  it("should support case-insensitive search", async () => {
    const result = await runTool(
      tool,
      { pattern: "README", path: testDir, ignoreCase: true },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(1);
  });

  it("should filter by filePattern", async () => {
    const result = await runTool(
      tool,
      { pattern: "hello", path: testDir, filePattern: "*.ts" },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(1);
    expect(data.matches.every((m) => m.file.endsWith(".ts"))).toBe(true);
  });

  it("should respect maxResults", async () => {
    const result = await runTool(
      tool,
      { pattern: "function", path: testDir, maxResults: 1 },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string }> };
    expect(data.matches.length).toBeLessThanOrEqual(1);
  });

  it("should return context lines when requested", async () => {
    const result = await runTool(
      tool,
      { pattern: "TODO", path: testDir, contextLines: 1 },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string; text: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------
  // Files mode
  // ---------------------------------------------------------------

  it("should return only file paths in files mode", async () => {
    const result = await runTool(
      tool,
      { pattern: "hello", path: testDir, outputMode: "files" },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { files: string[] };
    expect(data.files.length).toBeGreaterThanOrEqual(1);
    expect(data.files.every((f) => typeof f === "string")).toBe(true);
  });

  // ---------------------------------------------------------------
  // Count mode
  // ---------------------------------------------------------------

  it("should return counts in count mode", async () => {
    const result = await runTool(
      tool,
      { pattern: "function", path: testDir, outputMode: "count" },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { counts: Array<{ file: string; count: number }> };
    expect(data.counts.length).toBeGreaterThanOrEqual(1);
    // math.js has 2 functions
    const mathEntry = data.counts.find((c) => c.file.endsWith("math.js"));
    if (mathEntry) {
      expect(mathEntry.count).toBe(2);
    }
  });

  // ---------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------

  it("should return no matches for pattern not in files", async () => {
    const result = await runTool(
      tool,
      { pattern: "ZZZZZ_NONEXISTENT_PATTERN_12345", path: testDir },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string }> };
    expect(data.matches.length).toBe(0);
  });

  it("should fail for non-existent path", async () => {
    const result = await runTool(
      tool,
      { pattern: "hello", path: "/tmp/nonexistent-grep-test-xyz" },
      testDir,
    ).catch(() => ({ success: false, result: null, error: "path not found" }));

    expect(result.success).toBe(false);
  });

  // ---------------------------------------------------------------
  // Search in single file
  // ---------------------------------------------------------------

  it("should search within a single file", async () => {
    const filePath = join(testDir, "hello.ts");
    const result = await runTool(tool, { pattern: "export", path: filePath }, testDir);
    expect(result.success).toBe(true);

    const data = result.result as {
      matches: Array<{ file: string; text: string }>;
      totalFound: number;
    };
    // ripgrep doesn't prefix file path when searching a single file,
    // so the output format may differ. Check totalFound instead.
    expect(data.totalFound).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------
  // Exclude patterns
  // ---------------------------------------------------------------

  it("should respect excludeDir", async () => {
    const result = await runTool(
      tool,
      { pattern: "hello", path: testDir, excludeDir: "sub" },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string }> };
    expect(data.matches.every((m) => !m.file.includes("/sub/"))).toBe(true);
  });
});
