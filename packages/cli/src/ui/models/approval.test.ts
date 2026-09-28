import { describe, expect, it } from "bun:test";
import { approvalIntent, parseApprovalDiff } from "./approval";

describe("approvalIntent", () => {
  it("says an outbound message can't be unsent, and words the controls with the verb", () => {
    const intent = approvalIntent({ toolName: "gmail_send_email", args: { to: "a@example.com" } });
    expect(intent.headline).toBe("can't be unsent");
    expect(intent.accept).toBe("send");
    expect(intent.reject).toBe("don't send");
  });

  it("puts the measured size beside a deletion", () => {
    const intent = approvalIntent({
      toolName: "rm",
      args: { path: "/tmp/x" },
      impact: "214 files, 1.3 GB",
    });
    expect(intent.headline).toBe("can't be undone");
    expect(intent.impact).toEqual({ label: "removes", value: "214 files, 1.3 GB" });
  });

  it("shows a shell command as code and names a destructive one plainly", () => {
    const intent = approvalIntent({
      toolName: "execute_command",
      args: { command: "rm -rf ./build" },
    });
    expect(intent.command).toEqual({ text: "rm -rf ./build", language: "sh" });
    expect(intent.headline).toBe("deletes files");
    expect(intent.consumedKeys).toContain("command");
  });

  it("reads a low-risk command as running on this machine, not as a change", () => {
    const intent = approvalIntent({
      toolName: "execute_command",
      args: { command: "git status" },
      riskLevel: "low-risk",
    });
    expect(intent.headline).toBe("runs on this machine");
  });

  it("turns an edit's preview diff into rows and hides the raw edit operations", () => {
    const intent = approvalIntent({
      toolName: "edit_file",
      args: { path: "notes/week.md", edits: [], snapshot: "sha256:0" },
      previewDiff:
        "--- a/notes/week.md\n+++ b/notes/week.md\n@@ -12,1 +12,2 @@\n-Venue: undecided\n+Venue: Lisbon Loft\n+Hold: Sat 18:00\n",
    });
    expect(intent.diff?.added).toBe(2);
    expect(intent.diff?.removed).toBe(1);
    expect(intent.consumedKeys).toEqual(["edits", "snapshot"]);
  });

  it("does not show a diff for a brand-new file, only its size", () => {
    const intent = approvalIntent({
      toolName: "write_file",
      args: { path: "a.txt", content: "hi" },
      impact: "new file, 1 line",
      previewDiff: "@@ -0,0 +1,1 @@\n+hi\n",
    });
    expect(intent.headline).toBe("creates a file");
    expect(intent.diff).toBeUndefined();
  });
});

describe("parseApprovalDiff", () => {
  it("numbers rows from the hunk header and drops file headers", () => {
    const diff = parseApprovalDiff("--- a\n+++ b\n@@ -11,2 +11,2 @@\n context\n-old\n+new\n");
    expect(diff?.rows).toEqual([
      { sign: " ", text: "context", line: 11 },
      { sign: "-", text: "old", line: 12 },
      { sign: "+", text: "new", line: 12 },
    ]);
  });

  it("marks a gap between hunks", () => {
    const diff = parseApprovalDiff("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -20,1 +20,1 @@\n-c\n+d\n");
    expect(diff?.rows.some((row) => row.sign === "@")).toBe(true);
  });

  it("is undefined when nothing changes", () => {
    expect(parseApprovalDiff("--- a\n+++ b\n")).toBeUndefined();
  });
});
