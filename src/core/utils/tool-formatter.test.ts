import { describe, expect, test } from "bun:test";
import { formatToolArguments, formatToolResult, toolResultSnippet } from "./tool-formatter";

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

describe("toolResultSnippet", () => {
  test("skips brace-only JSON lines", () => {
    expect(toolResultSnippet('{\n  "ok": true\n}')).toBe('"ok": true');
  });

  test("joins the first two content lines", () => {
    expect(toolResultSnippet("Here're the files\n/notes.txt\n/people")).toBe(
      "Here're the files · /notes.txt",
    );
  });

  test("returns empty for braces only", () => {
    expect(toolResultSnippet("{\n}")).toBe("");
  });
});
