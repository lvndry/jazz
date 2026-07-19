import { describe, expect, it } from "bun:test";
import { passAt1, passAtK, passHatK, abDelta, bootstrapCI, makeRng } from "./metrics";

describe("metrics", () => {
  it("passAt1 is the mean of a task's samples", () => {
    expect(passAt1([true, false, true, false])).toBe(0.5);
  });
  it("passAtK is 1 if any sample passed", () => {
    expect(passAtK([false, false, true])).toBe(1);
    expect(passAtK([false, false, false])).toBe(0);
  });
  it("passHatK is 1 only if ALL samples passed (reliability)", () => {
    expect(passHatK([true, true, true])).toBe(1);
    expect(passHatK([true, false, true])).toBe(0);
  });
  it("abDelta reports difference and direction", () => {
    const d = abDelta(0.4, 0.6);
    expect(d.delta).toBeCloseTo(0.2, 5);
    expect(d.improved).toBe(true);
  });
  it("bootstrapCI is deterministic for a fixed seed", () => {
    const a = bootstrapCI([0.2, 0.8, 0.5, 1, 0], makeRng(42), 200);
    const b = bootstrapCI([0.2, 0.8, 0.5, 1, 0], makeRng(42), 200);
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(0.5, 5);
  });
});
