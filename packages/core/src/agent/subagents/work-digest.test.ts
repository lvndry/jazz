import { describe, expect, it } from "bun:test";
import { createSubagentWorkDigest } from "./work-digest";

describe("createSubagentWorkDigest", () => {
  it("says so when the child never called a tool", () => {
    expect(createSubagentWorkDigest().describe()).toBe(
      "It had made no tool calls before it stopped.",
    );
  });

  it("counts finished calls by tool and reports that nothing was changed", () => {
    const digest = createSubagentWorkDigest();
    digest.record({ kind: "tool-started", toolName: "read_file", toolCallId: "1" });
    digest.record({ kind: "tool-finished", toolName: "read_file", toolCallId: "1", ok: true });
    digest.record({ kind: "tool-started", toolName: "read_file", toolCallId: "2" });
    digest.record({ kind: "tool-finished", toolName: "read_file", toolCallId: "2", ok: true });
    expect(digest.describe()).toBe(
      "It had finished 2 tool calls (read_file ×2), changed no files.",
    );
  });

  it("reports files changed by a successful write", () => {
    const digest = createSubagentWorkDigest();
    digest.record({ kind: "tool-finished", toolName: "write_file", toolCallId: "1", ok: true });
    expect(digest.describe()).toBe(
      "It had finished 1 tool call (write_file ×1), changed files with write_file ×1.",
    );
  });

  it("does not count a failed write as a change", () => {
    const digest = createSubagentWorkDigest();
    digest.record({ kind: "tool-finished", toolName: "write_file", toolCallId: "1", ok: false });
    expect(digest.describe()).toBe(
      "It had finished 1 tool call (write_file ×1), 1 of them failed, changed no files.",
    );
  });

  it("notes a call that never finished", () => {
    const digest = createSubagentWorkDigest();
    digest.record({ kind: "tool-started", toolName: "execute_command", toolCallId: "1" });
    expect(digest.describe()).toBe(
      "It had finished no tool calls, changed no files. It was partway through a tool call when it stopped.",
    );
  });

  it("ignores approval requests", () => {
    const digest = createSubagentWorkDigest();
    digest.record({ kind: "approval-required", toolName: "execute_command", toolCallId: "1" });
    expect(digest.describe()).toBe("It had made no tool calls before it stopped.");
  });
});
