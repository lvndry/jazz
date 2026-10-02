import { describe, expect, it } from "bun:test";
import { resolveIterationCap } from "./agent";

describe("resolveIterationCap", () => {
  it("falls back to the default when no cap is requested", () => {
    expect(resolveIterationCap(undefined, 100)).toBe(100);
    expect(resolveIterationCap(undefined, Infinity)).toBe(Infinity);
  });

  it("treats 0 as unlimited on every surface", () => {
    expect(resolveIterationCap(0, 100)).toBe(Infinity);
  });

  it("treats an already-infinite request as unlimited", () => {
    expect(resolveIterationCap(Infinity, 30)).toBe(Infinity);
  });

  it("floors positive requests and clamps sub-1 values to 1", () => {
    expect(resolveIterationCap(50, 100)).toBe(50);
    expect(resolveIterationCap(59.9, 100)).toBe(59);
    expect(resolveIterationCap(0.5, 100)).toBe(1);
    expect(resolveIterationCap(1, 100)).toBe(1);
  });
});
