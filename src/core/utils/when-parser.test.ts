import { describe, test, expect } from "bun:test";
import { parseWhen, wallClockToEpoch, zonedDateParts } from "./when-parser";

describe("parseWhen", () => {
  test("parses a plain minute duration", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseWhen("30m", now, "UTC")).toBe(now + 30 * 60_000);
  });

  test("parses a plain hour duration", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseWhen("2h", now, "UTC")).toBe(now + 2 * 3_600_000);
  });

  test("parses a combined duration", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseWhen("1h30m", now, "UTC")).toBe(now + 90 * 60_000);
  });

  test("parses seconds and days", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseWhen("90s", now, "UTC")).toBe(now + 90_000);
    expect(parseWhen("1d", now, "UTC")).toBe(now + 86_400_000);
  });

  test("ignores whitespace between number and unit", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseWhen("1 h 30 m", now, "UTC")).toBe(now + 90 * 60_000);
  });

  test("parses a future clock time today", () => {
    const now = Date.UTC(2026, 0, 1, 10, 0, 0); // 10:00 UTC
    const fireAt = parseWhen("18:00", now, "UTC");
    expect(fireAt).toBe(Date.UTC(2026, 0, 1, 18, 0, 0));
  });

  test("rolls a past clock time to tomorrow", () => {
    const now = Date.UTC(2026, 0, 1, 20, 0, 0); // 20:00 UTC
    const fireAt = parseWhen("18:00", now, "UTC");
    expect(fireAt).toBe(Date.UTC(2026, 0, 2, 18, 0, 0));
  });

  test('parses "tomorrow HH:MM" explicitly', () => {
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);
    const fireAt = parseWhen("tomorrow 09:00", now, "UTC");
    expect(fireAt).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  test("is case-insensitive and trims whitespace", () => {
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(parseWhen("  TOMORROW 09:00  ", now, "UTC")).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
  });

  test("rejects an out-of-range clock time", () => {
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(parseWhen("24:00", now, "UTC")).toBeNull();
    expect(parseWhen("12:60", now, "UTC")).toBeNull();
  });

  test("rejects unparseable input", () => {
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(parseWhen("next friday at 2pm", now, "UTC")).toBeNull();
    expect(parseWhen("", now, "UTC")).toBeNull();
    expect(parseWhen("soon", now, "UTC")).toBeNull();
  });

  test("rejects a duration with trailing garbage", () => {
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(parseWhen("30m please", now, "UTC")).toBeNull();
  });

  test("interprets clock times in the given timezone, not UTC", () => {
    // 09:00 in America/New_York (UTC-5 in January) is 14:00 UTC.
    const now = Date.UTC(2026, 0, 1, 10, 0, 0); // 05:00 America/New_York
    const fireAt = parseWhen("09:00", now, "America/New_York");
    expect(fireAt).toBe(Date.UTC(2026, 0, 1, 14, 0, 0));
  });
});

describe("zonedDateParts", () => {
  test("returns the calendar date in UTC", () => {
    const epoch = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(zonedDateParts(epoch, "UTC")).toEqual({ year: 2026, month: 6, day: 15 });
  });

  test("returns a different calendar date across a timezone boundary", () => {
    // 23:30 UTC on June 15 is already June 16 in a UTC+2 zone.
    const epoch = Date.UTC(2026, 5, 15, 23, 30, 0);
    expect(zonedDateParts(epoch, "Europe/Paris")).toEqual({ year: 2026, month: 6, day: 16 });
  });
});

describe("wallClockToEpoch", () => {
  test("round-trips a UTC wall clock time", () => {
    const epoch = wallClockToEpoch(2026, 6, 15, 18, 0, "UTC");
    expect(epoch).toBe(Date.UTC(2026, 5, 15, 18, 0, 0));
  });

  test("accounts for a fixed timezone offset", () => {
    // 09:00 in Asia/Tokyo (UTC+9, no DST) is 00:00 UTC.
    const epoch = wallClockToEpoch(2026, 6, 15, 9, 0, "Asia/Tokyo");
    expect(epoch).toBe(Date.UTC(2026, 5, 15, 0, 0, 0));
  });
});
