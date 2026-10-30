import { describe, expect, test } from "bun:test";
import { getGlyphs } from "@/cli/ui/glyphs";
import {
  DRAIN_HALF_LIFE_MS,
  drainedPercent,
  planCompactionMeter,
  renderCompactionMeter,
} from "./compaction-meter";

describe("planCompactionMeter", () => {
  test("starts at the window's fill and floors at the kept tail", () => {
    const plan = planCompactionMeter(160_000, 200_000);
    expect(plan.startPercent).toBe(80);
    expect(plan.floorPercent).toBe(20);
  });

  test("never floors above where it starts", () => {
    const plan = planCompactionMeter(10_000, 200_000);
    expect(plan.floorPercent).toBeLessThanOrEqual(plan.startPercent);
  });
});

describe("drainedPercent", () => {
  const plan = { startPercent: 80, floorPercent: 20 };

  test("begins at the start", () => {
    expect(drainedPercent(plan, 0, 0)).toBe(80);
  });

  test("closes half the gap to the floor each half-life", () => {
    expect(drainedPercent(plan, DRAIN_HALF_LIFE_MS, 0)).toBeCloseTo(50);
    expect(drainedPercent(plan, 2 * DRAIN_HALF_LIFE_MS, 0)).toBeCloseTo(35);
  });

  test("drops at once by what pruning reclaimed", () => {
    expect(drainedPercent(plan, 0, 10)).toBe(70);
  });

  test("never goes below the floor", () => {
    expect(drainedPercent(plan, 0, 500)).toBe(20);
    expect(drainedPercent(plan, 60 * DRAIN_HALF_LIFE_MS, 0)).toBeGreaterThanOrEqual(20);
  });
});

describe("renderCompactionMeter", () => {
  test("lights fewer cells as the percent falls", () => {
    const glyphs = getGlyphs();
    const full = renderCompactionMeter(80, glyphs);
    const drained = renderCompactionMeter(20, glyphs);
    expect(full.split(glyphs.ruleHeavy).length).toBeGreaterThan(
      drained.split(glyphs.ruleHeavy).length,
    );
    expect(full.endsWith("80%")).toBe(true);
    expect(drained.endsWith("20%")).toBe(true);
  });
});
