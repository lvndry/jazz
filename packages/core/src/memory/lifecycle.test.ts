import { describe, expect, test } from "bun:test";
import { MAX_MEMORY_EVIDENCE } from "@/core/constants/memory";
import type { MemoryEvidence, MemoryFileProvenance } from "@/core/interfaces/memory-provenance";
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

  test("appends evidence and keeps only the most recent observations", () => {
    const observation = (index: number): MemoryEvidence => ({
      kind: "run",
      summary: `run ${index}`,
      recordedAt: "2026-01-02T00:00:00.000Z",
    });
    let provenance = base;
    for (let index = 0; index < MAX_MEMORY_EVIDENCE + 2; index += 1) {
      provenance = applyMemoryOutcome(provenance, {
        recalled: true,
        triggerFired: false,
        runId: String(index),
        evidence: observation(index),
      });
    }
    expect(provenance.evidence).toHaveLength(MAX_MEMORY_EVIDENCE);
    expect(provenance.evidence?.[0]?.summary).toBe("run 2");
    expect(provenance.evidence?.at(-1)?.summary).toBe(`run ${MAX_MEMORY_EVIDENCE + 1}`);
  });

  test("an outcome without evidence keeps what was already recorded", () => {
    const withEvidence = applyMemoryOutcome(base, {
      recalled: true,
      triggerFired: true,
      runId: "1",
      evidence: { kind: "misfire", summary: "failed", recordedAt: "2026-01-02T00:00:00.000Z" },
    });
    const later = applyMemoryOutcome(withEvidence, {
      recalled: true,
      triggerFired: false,
      runId: "2",
    });
    expect(later.evidence).toEqual(withEvidence.evidence);
  });
});
