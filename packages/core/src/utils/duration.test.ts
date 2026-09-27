import { describe, expect, it } from "bun:test";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  it("keeps sub-minute durations in seconds instead of rounding to 0m", () => {
    expect(formatDuration(20_000)).toBe("20s");
  });

  it("shows milliseconds below a second", () => {
    expect(formatDuration(850)).toBe("850ms");
  });

  it("shows minutes and leftover seconds", () => {
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(180_000)).toBe("3m");
  });

  it("shows hours and leftover minutes", () => {
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});
