/** Regression checks for human-readable handoff status. */
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import { getGlyphs } from "@/cli/ui/glyphs";
import {
  formatDetachEvent,
  formatDetachPull,
  formatDetachReclaim,
  formatDetachStatus,
} from "./detach";

describe("detached run status", () => {
  it("does not turn unreachable into a run failure", () => {
    expect(
      formatDetachStatus({
        handoffId: "transfer-1",
        hostName: "lysk",
        state: "unknown",
        detail: "SSH unavailable; the remote run may still be active.",
      }),
    ).toBe('transfer-1 on lysk: unknown\n"SSH unavailable; the remote run may still be active."\n');
  });

  it("shows the operator how to answer a parked run", () => {
    expect(
      formatDetachStatus({ handoffId: "transfer-2", hostName: "lysk", state: "parked" }),
    ).toContain("jazz detach approve transfer-2");
  });

  it("does not offer approval for a parked input that this version cannot answer", () => {
    const output = formatDetachStatus({
      handoffId: "transfer-4",
      hostName: "lysk",
      state: "parked",
      detail: "Run requires unsupported input",
      approvalAvailable: false,
    });
    expect(output).toContain("unsupported input");
    expect(output).not.toContain("jazz detach approve");
  });
});

describe("detached result download", () => {
  it("names changed and conflicting paths without claiming they were applied", () => {
    const output = formatDetachPull({
      handoffId: "transfer-3",
      hostName: "lysk",
      resultDirectory: "/tmp/jazz-results/transfer-3",
      changedPaths: ["src/app.ts"],
      conflicts: ["src/app.ts"],
    });
    expect(output).toContain('1 changed path:\n  "src/app.ts"');
    expect(output).toContain('1 conflict with local changes:\n  "src/app.ts"');
    expect(output).toContain(
      "Local files were not changed. This verified result requires manual reconciliation.",
    );
  });
});

describe("attached terminal rendering", () => {
  const glyphs = getGlyphs();
  const plain = stripVTControlCharacters;
  const at = "2026-09-26T00:00:00.000Z";

  it("streams answer text as-is and breaks the line before the next event", () => {
    expect(formatDetachEvent({ type: "text", delta: "Hi", at }, glyphs, true)).toBe("Hi");
    const tool = plain(
      formatDetachEvent(
        { type: "tool_start", toolCallId: "c", toolName: "grep", at },
        glyphs,
        false,
      ),
    );
    expect(tool.startsWith("\n")).toBe(true);
    expect(tool).toContain("grep");
  });

  it("labels the state that asks the operator to act", () => {
    expect(
      plain(formatDetachEvent({ type: "status", state: "completed", at }, glyphs, true)),
    ).toContain("finished, waiting for you");
    expect(
      plain(
        formatDetachEvent({ type: "status", state: "failed", detail: "boom", at }, glyphs, true),
      ),
    ).toContain("failed: boom");
  });

  it("keeps color semantic: only tool outcomes carry green or red", () => {
    const previous = chalk.level;
    chalk.level = 1;
    try {
      const ok = formatDetachEvent(
        { type: "tool_end", toolCallId: "c", success: true, durationMs: 1200, at },
        glyphs,
        true,
      );
      expect(ok).toContain(chalk.green(glyphs.success));
      expect(plain(ok)).toContain("1.2s");
    } finally {
      chalk.level = previous;
    }
  });
});

describe("reclaim summary", () => {
  const base = {
    handoffId: "transfer-4",
    hostName: "lysk",
    agentId: "agent",
    conversationId: "conversation-1",
  };

  it("says nothing was written when conflicts blocked the reclaim", () => {
    const text = formatDetachReclaim({
      ...base,
      applied: false,
      changedPaths: ["a.ts", "b.ts"],
      conflicts: ["a.ts"],
    });
    expect(text).toContain("Nothing was written");
    expect(text).toContain("--overwrite");
    expect(text).toContain('"a.ts"');
  });

  it("tells the operator how to continue locally", () => {
    const text = formatDetachReclaim({ ...base, applied: true, changedPaths: [], conflicts: [] });
    expect(text).toContain("0 files updated.");
    expect(text).toContain("/resume");
  });
});
