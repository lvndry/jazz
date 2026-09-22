import { describe, expect, test } from "bun:test";
import type { MemoryFileProvenance } from "@/core/interfaces/memory-provenance";
import { applyMemoryOutcome } from "./lifecycle";

const base: MemoryFileProvenance = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  writeCount: 1,
  writtenBy: ["agent"],
};

describe("applyMemoryOutcome", () => {
  test("credits a recalled lesson only after its trigger has fired", () => {
    const fired = applyMemoryOutcome(base, { recalled: false, triggerFired: true, runId: "1" });
    const helped = applyMemoryOutcome(fired, { recalled: true, triggerFired: false, runId: "2" });
    expect(helped.credit).toEqual({ helped: 1, failed: 0, missed: 1, everFired: true });
  });

  test("separates content failure from routing misses", () => {
    const result = applyMemoryOutcome(
      applyMemoryOutcome(base, { recalled: true, triggerFired: true, runId: "1" }),
      { recalled: false, triggerFired: true, runId: "2" },
    );
    expect(result.credit).toEqual({ helped: 0, failed: 1, missed: 1, everFired: true });
  });

  test("retains evidence without mutating the source", () => {
    const result = applyMemoryOutcome(base, {
      recalled: true,
      triggerFired: true,
      runId: "run-1",
      evidence: {
        kind: "misfire",
        summary: "edit_file failed",
        recordedAt: "2026-01-02T00:00:00.000Z",
        runId: "run-1",
      },
    });
    expect(base.evidence).toBeUndefined();
    expect(result.evidence?.[0]?.summary).toBe("edit_file failed");
  });
});
