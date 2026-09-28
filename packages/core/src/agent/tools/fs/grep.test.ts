/** Content-search regressions include ambiguous filenames and credential-like delimiter text. */
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createGrepTool } from "./grep";
import { createReadFileTool } from "./read";
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

  it("should strip a re: prefix even when regex:true is also set", async () => {
    const result = await runTool(
      tool,
      { pattern: "re:function\\s+\\w+", path: testDir, regex: true },
      testDir,
    );
    expect(result.success).toBe(true);

    const data = result.result as { matches: Array<{ file: string; text: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(2);
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

describe("grep filename framing", () => {
  for (const backend of ["ripgrep", "grep"] as const) {
    it.skipIf(backend === "ripgrep" && Bun.which("rg") === null)(
      `keeps protected content out of all output modes with ${backend}`,
      () => {
        const root = mkdtempSync(join(tmpdir(), "jazz-grep-framing-"));
        try {
          const workspace = join(root, "workspace");
          const home = join(root, "home");
          mkdirSync(workspace);
          const protectedPath = join(workspace, "backup:42:odd\nname.txt");
          const ordinaryPath = join(workspace, "ordinary:19:odd\nname.txt");
          writeFileSync(
            protectedPath,
            "before:12:PRIVATE_CONTEXT\nTOKEN=prefix:123:PRIVATE_VALUE\nafter-13-PRIVATE_CONTEXT\n",
          );
          writeFileSync(
            ordinaryPath,
            "before:12:public\nTOKEN=prefix:123:public-value\nafter-13-public\n",
          );
          symlinkSync(protectedPath, join(workspace, "alias.txt"));
          const binaryPath = join(workspace, "binary-backup");
          writeFileSync(binaryPath, "TOKEN=PRIVATE_BINARY\0tail\n");
          const bin = join(root, "bin");
          mkdirSync(bin);
          const grep = Bun.which("grep");
          const rg = Bun.which("rg");
          expect(grep).not.toBeNull();
          symlinkSync(grep!, join(bin, "grep"));
          if (backend === "grep") {
            writeFileSync(join(bin, "rg"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
          } else {
            expect(rg).not.toBeNull();
            symlinkSync(rg!, join(bin, "rg"));
          }
          const child = Bun.spawnSync({
            cmd: [
              process.execPath,
              "-e",
              `
          import { createGrepTool } from ${JSON.stringify(import.meta.dir + "/grep.ts")};
          import { runTool } from ${JSON.stringify(import.meta.dir + "/test-helpers.ts")};
          import { registerProtectedFileRoots } from ${JSON.stringify(import.meta.dir + "/../../../utils/protected-files.ts")};
          await registerProtectedFileRoots([${JSON.stringify(protectedPath)}, ${JSON.stringify(binaryPath)}]);
          const results = [];
          for (const outputMode of ["content", "files", "count"]) {
            results.push(await runTool(createGrepTool(), {
              path: ${JSON.stringify(workspace)}, pattern: "TOKEN", contextLines: 1, outputMode
            }, ${JSON.stringify(workspace)}));
          }
          console.log(JSON.stringify(results));
        `,
            ],
            env: { ...process.env, JAZZ_HOME: home, PATH: bin },
          });
          expect(child.exitCode).toBe(0);
          const output = child.stdout.toString();
          expect(output).not.toContain("PRIVATE_VALUE");
          expect(output).not.toContain("PRIVATE_CONTEXT");
          expect(output).not.toContain("PRIVATE_BINARY");
          const results = JSON.parse(output) as Array<{
            success: boolean;
            result: Record<string, unknown>;
          }>;
          expect(
            results.every((result) => result.success && result.result["backend"] === backend),
          ).toBe(true);
          expect(results[0]?.result["matches"]).toEqual([
            {
              file: ordinaryPath,
              line: 2,
              text: "TOKEN=prefix:123:public-value",
              contextBefore: [{ line: 1, text: "before:12:public" }],
              contextAfter: [{ line: 3, text: "after-13-public" }],
            },
          ]);
          expect(results[1]?.result["files"]).toEqual([ordinaryPath]);
          expect(results[2]?.result["counts"]).toEqual([{ file: ordinaryPath, count: 1 }]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
});

describe("internal transfer staging", () => {
  it.each(["stage", "previous"])("omits nested ordinary files under %s paths", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "jazz-grep-staging-"));
    try {
      const nested = join(root, `.jazz-${kind}-destination-id`, "nested");
      mkdirSync(nested, { recursive: true });
      const file = join(nested, "ordinary.txt");
      writeFileSync(file, "TOKEN=staging-private");
      const read = await runTool(createReadFileTool(), { path: file }, root);
      expect(read.result).toMatchObject({ protected: true, contentOmitted: true });
      const search = await runTool(
        createGrepTool(),
        { path: root, pattern: "TOKEN", filePattern: "**/*" },
        root,
      );
      expect(JSON.stringify(search)).not.toContain("staging-private");
      expect(search.success).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
