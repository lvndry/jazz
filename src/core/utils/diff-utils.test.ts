import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import { generateDiff } from "./diff-utils";

// Disable chalk colors for predictable test output
chalk.level = 0;

describe("diff-utils", () => {
  describe("generateDiff", () => {
    it("returns creation message for new files", () => {
      const result = generateDiff("", "line1\nline2\nline3", "/path/to/file.txt", {
        isNewFile: true,
      });
      expect(result).toContain("Created file");
      expect(result).toContain("3 lines");
    });

    it("returns creation message when original is empty", () => {
      const result = generateDiff("", "new content", "/path/to/file.txt");
      expect(result).toContain("Created file");
    });

    it("returns empty string when content is identical", () => {
      const content = "line1\nline2\nline3";
      const result = generateDiff(content, content, "/path/to/file.txt");
      expect(result).toBe("");
    });

    it("shows simple single-line change", () => {
      const original = "hello world";
      const modified = "hello jazz";
      const result = generateDiff(original, modified, "/path/to/file.txt");

      expect(result).toContain("--- a/file.txt");
      expect(result).toContain("+++ b/file.txt");
      expect(result).toContain("-hello world");
      expect(result).toContain("+hello jazz");
    });

    it("shows additions at end of file", () => {
      const original = "line1\nline2";
      const modified = "line1\nline2\nline3";
      const result = generateDiff(original, modified, "/path/to/file.txt");

      expect(result).toContain("+line3");
    });

    it("shows deletions", () => {
      const original = "line1\nline2\nline3";
      const modified = "line1\nline3";
      const result = generateDiff(original, modified, "/path/to/file.txt");

      expect(result).toContain("-line2");
    });

    it("shows hunk headers", () => {
      const original = "line1";
      const modified = "line1\nnew line";
      const result = generateDiff(original, modified, "/path/to/file.txt");

      expect(result).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    });

    it("extracts basename from filepath", () => {
      const result = generateDiff("old", "new", "/very/long/path/to/myfile.ts");

      expect(result).toContain("a/myfile.ts");
      expect(result).toContain("b/myfile.ts");
    });
  });
});
