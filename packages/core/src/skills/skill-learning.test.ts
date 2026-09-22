import { describe, expect, test } from "bun:test";
import type { MisfireEntry } from "@/core/agent/tools/misfire-log";
import { proposeSkillFromMisfires } from "./skill-learning";

const entry = (message: string): MisfireEntry => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  toolName: "edit_file",
  kind: "runtime_error",
  errorMessage: message,
  durationMs: 10,
});

describe("proposeSkillFromMisfires", () => {
  test("requires recurrence", () => {
    expect(proposeSkillFromMisfires([entry("pattern not found")])).toBeUndefined();
  });

  test("does not treat two different failures of one tool as a pattern", () => {
    expect(
      proposeSkillFromMisfires([entry("pattern not found"), entry("permission denied")]),
    ).toBeUndefined();
  });

  test("keeps paths and ids out of the proposal", () => {
    const proposal = proposeSkillFromMisfires([
      entry("ENOENT /Users/someone/notes/a.md"),
      entry("ENOENT /Users/someone/notes/b.md"),
    ]);
    expect(proposal?.failureClass).toBe("ENOENT $HOME");
    expect(proposal?.content).not.toContain("/Users/");
  });

  test("creates a bounded proposal without mutating files", () => {
    const proposal = proposeSkillFromMisfires([
      entry("pattern not found"),
      entry("pattern not found"),
    ]);
    expect(proposal?.target).toBe("project");
    expect(proposal?.name).toBe("edit-file-recovery");
    expect(proposal?.content).toContain("Verify");
    expect(proposal?.evidenceCount).toBe(2);
  });
});
