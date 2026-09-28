import { describe, expect, test } from "bun:test";
import { isRejectedResult, receiptOutcome } from "./receipt-outcome";

describe("receiptOutcome", () => {
  test("a whole-file read is its line count", () => {
    const result = JSON.stringify({
      path: "/repo/README.md",
      content: '1|<div align="center">\n2|',
      totalLines: 300,
      returnedLines: 300,
      range: { startLine: 1, endLine: 300 },
    });
    expect(receiptOutcome(result)).toBe("300 lines");
  });

  test("a partial read names the range it covered", () => {
    const result = JSON.stringify({
      content: "…",
      totalLines: 900,
      range: { startLine: 1, endLine: 180 },
    });
    expect(receiptOutcome(result)).toBe("lines 1–180 of 900");
  });

  test("a directory listing is its entry count, never its JSON", () => {
    const result = JSON.stringify([
      { path: "/repo/packages/bot-shared", name: "bot-shared", type: "dir" },
      { path: "/repo/packages/cli", name: "cli", type: "dir" },
    ]);
    expect(receiptOutcome(result)).toBe("2 entries");
  });

  test("search results count their matches", () => {
    expect(
      receiptOutcome(JSON.stringify({ matches: new Array(23).fill({}), totalFound: 23 })),
    ).toBe("23 matches");
    expect(receiptOutcome(JSON.stringify({ matches: [{}] }))).toBe("1 match");
    expect(receiptOutcome(JSON.stringify({ files: [] }))).toBe("none");
  });

  test("a command is its exit code when it failed, its output size when it did not", () => {
    expect(receiptOutcome(JSON.stringify({ exitCode: 2, stdout: "", stderr: "boom" }))).toBe(
      "exit 2",
    );
    expect(receiptOutcome(JSON.stringify({ exitCode: 0, stdout: "a\nb\n" }))).toBe("2 lines");
    expect(receiptOutcome(JSON.stringify({ exitCode: 0, stdout: "" }))).toBe("done");
  });

  test("a write states what it did and the size of the change", () => {
    expect(
      receiptOutcome(
        JSON.stringify({ isNewFile: false, diff: "--- a\n+++ b\n+one\n+two\n-three" }),
      ),
    ).toBe("written +2 −1");
    expect(receiptOutcome(JSON.stringify({ isNewFile: true }))).toBe("created");
  });

  test("todos are progress, an HTTP call is its status", () => {
    expect(
      receiptOutcome(JSON.stringify({ todos: [{ status: "completed" }, { status: "pending" }] })),
    ).toBe("1 of 2 done");
    expect(receiptOutcome(JSON.stringify({ status: 404, body: "…" }))).toBe("HTTP 404");
  });

  test("a nested outcome is looked through", () => {
    const result = JSON.stringify({
      formatted: "Here're the files and directories…\n/notes.txt",
      outcome: { kind: "directory", entries: [{ name: "notes.txt" }] },
    });
    expect(receiptOutcome(result)).toBe("1 entry");
  });

  test("a short message is kept, a long or multi-line one is only counted", () => {
    expect(receiptOutcome(JSON.stringify({ message: "Reminder set" }))).toBe("Reminder set");
    expect(receiptOutcome("plain text reply")).toBe("plain text reply");
    expect(receiptOutcome("line one\nline two\nline three")).toBe("3 lines");
  });

  test("nothing useful to say is undefined", () => {
    expect(receiptOutcome("")).toBeUndefined();
    expect(receiptOutcome(JSON.stringify({ unrelated: { deep: true } }))).toBeUndefined();
  });
});

describe("isRejectedResult", () => {
  test("recognises the declined-by-a-person shape", () => {
    expect(isRejectedResult(JSON.stringify({ rejected: true, message: "no" }))).toBe(true);
    expect(isRejectedResult(JSON.stringify({ error: "x", result: { rejected: true } }))).toBe(true);
    expect(isRejectedResult(JSON.stringify({ error: "disk full" }))).toBe(false);
    expect(isRejectedResult("Error: boom")).toBe(false);
  });
});
