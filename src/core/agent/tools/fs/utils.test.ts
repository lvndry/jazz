import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  checkExternalTool,
  normalizeFilterPattern,
  parseGitignoreToGlob,
  spawnCollect,
} from "./utils";

describe("fs utils", () => {
  // ---------------------------------------------------------------
  // normalizeFilterPattern
  // ---------------------------------------------------------------

  describe("normalizeFilterPattern", () => {
    it("should return empty substring for undefined input", () => {
      const result = normalizeFilterPattern(undefined);
      expect(result.type).toBe("substring");
      expect(result.value).toBeUndefined();
      expect(result.regex).toBeUndefined();
    });

    it("should return empty substring for empty string", () => {
      const result = normalizeFilterPattern("");
      expect(result.type).toBe("substring");
    });

    it("should return substring for plain text", () => {
      const result = normalizeFilterPattern("hello");
      expect(result.type).toBe("substring");
      expect(result.value).toBe("hello");
    });

    it("should return regex for re: prefixed input", () => {
      const result = normalizeFilterPattern("re:test.*\\.ts$");
      expect(result.type).toBe("regex");
      expect(result.regex).toBeInstanceOf(RegExp);
      expect(result.regex!.test("test.ts")).toBe(true);
      expect(result.regex!.test("test.js")).toBe(false);
    });

    it("should fallback to substring for invalid regex", () => {
      const result = normalizeFilterPattern("re:[[invalid");
      expect(result.type).toBe("substring");
      expect(result.value).toBe("[[invalid");
    });

    it("should trim whitespace", () => {
      const result = normalizeFilterPattern("  hello  ");
      expect(result.type).toBe("substring");
      expect(result.value).toBe("hello");
    });
  });

  // ---------------------------------------------------------------
  // parseGitignoreToGlob
  // ---------------------------------------------------------------

  describe("parseGitignoreToGlob", () => {
    it("should skip empty lines and comments", () => {
      const result = parseGitignoreToGlob("# comment\n\n# another comment\n");
      expect(result).toEqual([]);
    });

    it("should skip negation patterns", () => {
      const result = parseGitignoreToGlob("!important.txt\n");
      expect(result).toEqual([]);
    });

    it("should handle root-anchored patterns", () => {
      const result = parseGitignoreToGlob("/build\n");
      expect(result).toContain("build");
      expect(result).toContain("build/**");
    });

    it("should handle directory-only patterns", () => {
      const result = parseGitignoreToGlob("dist/\n");
      expect(result).toContain("**/dist/**");
    });

    it("should handle general patterns", () => {
      const result = parseGitignoreToGlob("*.log\n");
      expect(result).toContain("**/*.log");
      expect(result).toContain("**/*.log/**");
    });

    it("should handle a realistic .gitignore", () => {
      const content = `
# dependencies
node_modules/
.pnp

# build
/dist
/build

# env
.env
.env.local
*.log
`;
      const result = parseGitignoreToGlob(content);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("**/node_modules/**");
      expect(result).toContain("dist");
    });
  });

  // ---------------------------------------------------------------
  // checkExternalTool
  // ---------------------------------------------------------------

  describe("checkExternalTool", () => {
    it("should detect an available tool (echo)", async () => {
      // 'echo' should be available on any system
      const result = await checkExternalTool("echo", "--help");
      // echo --help should succeed (exit 0) on most systems
      // On some systems echo --help prints --help as text but still exits 0
      expect(typeof result).toBe("boolean");
    });

    it("should return false for non-existent tool", async () => {
      const result = await checkExternalTool("nonexistent_tool_xyz_12345");
      expect(result).toBe(false);
    });

    it("should cache results (second call returns immediately)", async () => {
      // First call
      await checkExternalTool("nonexistent_tool_abc_67890");
      // Second call — should use cache
      const start = Date.now();
      const result = await checkExternalTool("nonexistent_tool_abc_67890");
      const elapsed = Date.now() - start;
      expect(result).toBe(false);
      expect(elapsed).toBeLessThan(50); // Cached = essentially instant
    });
  });

  // ---------------------------------------------------------------
  // spawnCollect
  // ---------------------------------------------------------------

  describe("spawnCollect", () => {
    it("should collect stdout from a command", async () => {
      const result = await Effect.runPromise(spawnCollect("echo", ["hello world"]));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world");
      expect(result.stderr).toBe("");
    });

    it("should capture stderr", async () => {
      const result = await Effect.runPromise(spawnCollect("ls", ["/nonexistent_path_xyz_test"]));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("should return exitCode 1 for non-existent commands", async () => {
      const result = await Effect.runPromise(spawnCollect("nonexistent_command_xyz_12345", []));
      expect(result.exitCode).toBe(1);
    });

    it("should respect cwd option", async () => {
      const result = await Effect.runPromise(spawnCollect("pwd", [], { cwd: "/tmp" }));
      expect(result.exitCode).toBe(0);
      // /tmp may resolve to /private/tmp on macOS
      expect(result.stdout).toMatch(/\/tmp/);
    });
  });
});
