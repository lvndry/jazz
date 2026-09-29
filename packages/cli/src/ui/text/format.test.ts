import { describe, expect, it } from "bun:test";
import { formatCost, formatElapsed, formatPreciseDuration } from "./format";

describe("formatPreciseDuration", () => {
  it("keeps tenths of a second under a minute, a short run included", () => {
    expect(formatPreciseDuration(840)).toBe("0.8s");
    expect(formatPreciseDuration(0)).toBe("0.0s");
    expect(formatPreciseDuration(4_140)).toBe("4.1s");
    expect(formatPreciseDuration(59_940)).toBe("59.9s");
  });

  it("never prints sixty seconds inside a minute", () => {
    expect(formatPreciseDuration(119_600)).toBe("2m 00s");
    expect(formatPreciseDuration(125_000)).toBe("2m 05s");
  });

  it("rounds a tenth that reaches a minute up into minutes", () => {
    expect(formatPreciseDuration(59_960)).toBe("1m 00s");
  });
});

describe("formatElapsed", () => {
  it("counts whole seconds rounded down, so it ticks once a second", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1_999)).toBe("1s");
    expect(formatElapsed(187_400)).toBe("3m 07s");
  });

  it("clamps a negative clock skew to zero", () => {
    expect(formatElapsed(-50)).toBe("0s");
  });
});

describe("formatCost", () => {
  it("shows cents above a cent and four decimals below it", () => {
    expect(formatCost(1.2749)).toBe("$1.27");
    expect(formatCost(0.0042)).toBe("$0.0042");
  });

  it("never lets a cheap run read as free", () => {
    expect(formatCost(0.00003)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("$0.00");
  });
});
