import { describe, expect, test } from "bun:test";
import {
  compactToolArguments,
  expandableFileMutationPayload,
  FILE_MUTATION_PREVIEW_CHARS,
  formatToolArguments,
  formatToolResult,
} from "./tool-formatter";

describe("formatToolArguments http_request", () => {
  test("merges query params into the displayed URL", () => {
    const formatted = formatToolArguments(
      "http_request",
      {
        method: "GET",
        url: "https://duckduckgo.com/html/",
        query: { q: "Ye latest concert 2025" },
      },
      { style: "plain" },
    );
    expect(formatted).toContain("https://duckduckgo.com/html/?q=Ye%20latest%20concert%202025");
  });

  test("appends with & when the URL already has a query string", () => {
    const formatted = formatToolArguments(
      "http_request",
      {
        method: "GET",
        url: "https://example.com/search?page=2",
        query: { q: "tickets" },
      },
      { style: "plain" },
    );
    expect(formatted).toContain("https://example.com/search?page=2&q=tickets");
  });

  test("leaves the URL untouched without query params", () => {
    const formatted = formatToolArguments(
      "http_request",
      { method: "GET", url: "https://example.com/" },
      { style: "plain" },
    );
    expect(formatted).toContain("url: https://example.com/");
    expect(formatted).not.toContain("?");
  });
});

function formatCommand(result: { stdout?: string; stderr?: string; exitCode?: number }): string {
  return formatToolResult("execute_command", JSON.stringify(result));
}

describe("formatToolResult execute_command", () => {
  test("stdout only renders the output without labels", () => {
    const formatted = formatCommand({ stdout: "hello", exitCode: 0 });
    expect(formatted).toBe("hello");
  });

  test("stderr-only output keeps the stderr label", () => {
    const formatted = formatCommand({ stderr: "command not found", exitCode: 0 });
    expect(formatted).toBe("stderr:\ncommand not found");
  });

  test("both streams are separated and stderr is labeled", () => {
    const formatted = formatCommand({ stdout: "partial", stderr: "warning", exitCode: 0 });
    expect(formatted).toBe("partial\n\nstderr:\nwarning");
  });

  test("nonzero exit with output appends the failure footer", () => {
    const formatted = formatCommand({ stderr: "boom", exitCode: 2 });
    expect(formatted).toBe("stderr:\nboom\n\nfailed (exit code 2)");
  });

  test("nonzero exit without output reports failure and exit code", () => {
    const formatted = formatCommand({ exitCode: 127 });
    expect(formatted).toBe("failed (exit code 127), no output");
  });

  test("zero exit without output reports no output", () => {
    const formatted = formatCommand({ exitCode: 0 });
    expect(formatted).toBe("no output");
  });
});

describe("formatToolArguments view_memory", () => {
  test("empty path displays as root", () => {
    const formatted = formatToolArguments("view_memory", { path: "" }, { style: "plain" });
    expect(formatted).toContain("path: /");
  });

  test("missing args still display as root", () => {
    const formatted = formatToolArguments("view_memory", undefined, { style: "plain" });
    expect(formatted).toContain("path: /");
  });

  test("a file path is shown as-is", () => {
    const formatted = formatToolArguments(
      "view_memory",
      { path: "people/alex.md" },
      { style: "plain" },
    );
    expect(formatted).toContain("path: people/alex.md");
  });

  test("view_range is shown as a line span", () => {
    const formatted = formatToolArguments(
      "view_memory",
      { path: "notes.md", view_range: [1, 40] },
      { style: "plain" },
    );
    expect(formatted).toContain("path: notes.md");
    expect(formatted).toContain("lines: 1–40");
  });
});

describe("formatToolArguments default", () => {
  test("skips empty string values", () => {
    const formatted = formatToolArguments(
      "custom_tool",
      { path: "", limit: 5 },
      { style: "plain" },
    );
    expect(formatted).not.toContain("path:");
    expect(formatted).toContain("limit: 5");
  });

  test("stringifies object values instead of dropping them", () => {
    const formatted = formatToolArguments(
      "custom_tool",
      { filter: { status: "open" } },
      { style: "plain" },
    );
    expect(formatted).toContain('{"status":"open"}');
  });
});

describe("formatToolResult generic objects", () => {
  test("prefers a formatted string over pretty-printed JSON", () => {
    const formatted = formatToolResult(
      "view_memory",
      JSON.stringify({
        formatted: "Here're the files and directories up to 2 levels deep in /:\n/notes.txt",
        outcome: { kind: "directory", path: "/", entries: [] },
      }),
    );
    expect(formatted).toContain("Here're the files and directories");
    expect(formatted).toContain("/notes.txt");
    expect(formatted.trimStart().startsWith("{")).toBe(false);
  });
});

describe("formatToolArguments write_file / edit_file", () => {
  test("includes a collapsed content preview", () => {
    const formatted = formatToolArguments(
      "write_file",
      { path: "src/app.py", content: "def main():\n    print('hi')" },
      { style: "plain" },
    );
    expect(formatted).toContain("file: src/app.py");
    expect(formatted).toContain("def main(): print('hi')");
    expect(formatted).not.toContain("\n");
  });

  test("truncates long write content at the preview budget", () => {
    const content = "x".repeat(FILE_MUTATION_PREVIEW_CHARS + 80);
    const formatted = formatToolArguments(
      "write_file",
      { path: "out.js", content },
      { style: "plain" },
    );
    expect(formatted).toContain("file: out.js");
    expect(formatted).toContain("…");
    expect(formatted.length).toBeLessThan(content.length);
    const preview = compactToolArguments("write_file", { path: "out.js", content });
    expect(preview.endsWith("…")).toBe(true);
  });

  test("includes edit replacement text in the preview", () => {
    const formatted = formatToolArguments(
      "edit_file",
      {
        path: "src/app.ts",
        edits: [{ type: "replace_pattern", pattern: "foo", replacement: "const renamed = 1" }],
      },
      { style: "plain" },
    );
    expect(formatted).toContain("file: src/app.ts");
    expect(formatted).toContain("const renamed = 1");
  });
});

describe("formatToolResult write_file / edit_file", () => {
  test("keeps a short diff intact", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const formatted = formatToolResult("edit_file", JSON.stringify({ diff, path: "a.ts" }));
    expect(formatted).toBe(diff);
    expect(formatted).not.toContain("ctrl+o");
  });

  test("truncates a long diff and points at Ctrl+O", () => {
    const diff = Array.from(
      { length: 40 },
      (_, index) => `+line ${String(index)} ${"y".repeat(20)}`,
    ).join("\n");
    const formatted = formatToolResult("write_file", JSON.stringify({ diff, path: "out.py" }));
    expect(formatted.length).toBeLessThan(diff.length);
    expect(formatted).toContain("… · ctrl+o to expand");
    expect(formatted.startsWith(diff.slice(0, 20))).toBe(true);
  });
});

describe("expandableFileMutationPayload", () => {
  test("returns null when the diff already fits the preview", () => {
    expect(
      expandableFileMutationPayload(
        JSON.stringify({ diff: "short", wasTruncated: false, fullDiff: "" }),
      ),
    ).toBeNull();
  });

  test("prefers fullDiff when the display was truncated", () => {
    const fullDiff = "x".repeat(FILE_MUTATION_PREVIEW_CHARS + 10);
    expect(
      expandableFileMutationPayload(
        JSON.stringify({ diff: "preview", wasTruncated: true, fullDiff }),
      ),
    ).toBe(fullDiff);
  });
});

describe("compactToolArguments", () => {
  const cwd = "/work/jazz";

  test("reads a file range as the path and a span", () => {
    expect(
      compactToolArguments(
        "read_file",
        { path: "/work/jazz/README.md", startLine: 1, endLine: 300 },
        cwd,
      ),
    ).toBe("README.md 1–300");
  });

  test("shows paths relative to the working directory, and as given outside it", () => {
    expect(compactToolArguments("ls", { path: "/work/jazz/packages" }, cwd)).toBe("packages");
    expect(compactToolArguments("ls", { path: "/work/jazz" }, cwd)).toBe(".");
    expect(compactToolArguments("ls", { path: "/elsewhere/notes" }, cwd)).toBe("/elsewhere/notes");
  });

  test("phrases a search as the pattern in its place", () => {
    expect(compactToolArguments("grep", { pattern: "TODO", path: "/work/jazz/src" }, cwd)).toBe(
      '"TODO" in src',
    );
    expect(compactToolArguments("grep", { pattern: "TODO" }, cwd)).toBe('"TODO"');
  });

  test("shows a command, a request and a query as themselves", () => {
    expect(compactToolArguments("execute_command", { command: "git status" }, cwd)).toBe(
      "git status",
    );
    expect(compactToolArguments("http_request", { url: "https://example.com/a" }, cwd)).toBe(
      "GET https://example.com/a",
    );
    expect(compactToolArguments("web_search", { query: "lisbon venues" }, cwd)).toBe(
      '"lisbon venues"',
    );
  });

  test("puts the path first for a file mutation, then its preview", () => {
    const preview = compactToolArguments(
      "write_file",
      { path: "/work/jazz/src/app.py", content: "import os\n" },
      cwd,
    );
    expect(preview.startsWith("src/app.py  ")).toBe(true);
  });

  test("says nothing beside a plan update", () => {
    expect(compactToolArguments("manage_todos", { todos: [{ content: "a" }] }, cwd)).toBe("");
  });

  test("keeps key names for tools it knows nothing about", () => {
    expect(compactToolArguments("gmail_search", { query: "is:flagged" }, cwd)).toBe(
      "query: is:flagged",
    );
  });
});
