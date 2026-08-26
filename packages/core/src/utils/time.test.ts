import { describe, expect, test } from "bun:test";
import { parseWhen, wallClockToEpoch, zonedDateParts, zonedWeekday } from "./time";

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
    const now = Date.UTC(2026, 0, 1, 10, 0, 0);
    expect(parseWhen("18:00", now, "UTC")).toBe(Date.UTC(2026, 0, 1, 18, 0, 0));
  });

  test("rolls a past clock time to tomorrow", () => {
    const now = Date.UTC(2026, 0, 1, 20, 0, 0);
    expect(parseWhen("18:00", now, "UTC")).toBe(Date.UTC(2026, 0, 2, 18, 0, 0));
  });

  test('parses "tomorrow HH:MM" explicitly', () => {
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(parseWhen("tomorrow 09:00", now, "UTC")).toBe(Date.UTC(2026, 0, 2, 9, 0, 0));
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
    const now = Date.UTC(2026, 0, 1, 10, 0, 0);
    expect(parseWhen("09:00", now, "America/New_York")).toBe(Date.UTC(2026, 0, 1, 14, 0, 0));
  });
});

describe("zonedDateParts", () => {
  test("returns the calendar date in UTC", () => {
    const epoch = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(zonedDateParts(epoch, "UTC")).toEqual({ year: 2026, month: 6, day: 15 });
  });

  test("returns a different calendar date across a timezone boundary", () => {
    const epoch = Date.UTC(2026, 5, 15, 23, 30, 0);
    expect(zonedDateParts(epoch, "Europe/Paris")).toEqual({ year: 2026, month: 6, day: 16 });
  });
});

describe("wallClockToEpoch", () => {
  test("round-trips a UTC wall clock time", () => {
    expect(wallClockToEpoch(2026, 6, 15, 18, 0, "UTC")).toBe(Date.UTC(2026, 5, 15, 18, 0, 0));
  });

  test("accounts for a fixed timezone offset", () => {
    expect(wallClockToEpoch(2026, 6, 15, 9, 0, "Asia/Tokyo")).toBe(Date.UTC(2026, 5, 15, 0, 0, 0));
  });
});

describe("parseWhen absolute and weekday forms", () => {
  test("parses an absolute date and time", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("2026-08-25 20:00", now, "UTC")).toBe(Date.UTC(2026, 7, 25, 20, 0, 0));
  });

  test("accepts an ISO-style T separator", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("2026-08-25T20:00", now, "UTC")).toBe(Date.UTC(2026, 7, 25, 20, 0, 0));
  });

  test("interprets an absolute time in the caller timezone", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("2026-08-25 20:00", now, "Europe/Paris")).toBe(
      Date.UTC(2026, 7, 25, 18, 0, 0),
    );
  });

  test("returns a past absolute time rather than null", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("2026-08-01 09:00", now, "UTC")).toBe(Date.UTC(2026, 7, 1, 9, 0, 0));
  });

  test("rejects an out-of-range absolute date", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("2026-13-01 09:00", now, "UTC")).toBeNull();
  });

  test("parses the next occurrence of a weekday", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("tue 20:00", now, "UTC")).toBe(Date.UTC(2026, 7, 25, 20, 0, 0));
    expect(parseWhen("tuesday 20:00", now, "UTC")).toBe(Date.UTC(2026, 7, 25, 20, 0, 0));
  });

  test("keeps today when that weekday time is still ahead", () => {
    const now = Date.UTC(2026, 7, 24, 10, 0, 0);
    expect(parseWhen("monday 20:00", now, "UTC")).toBe(Date.UTC(2026, 7, 24, 20, 0, 0));
  });

  test("rolls to next week when today's weekday time has passed", () => {
    const now = Date.UTC(2026, 7, 24, 21, 0, 0);
    expect(parseWhen("monday 20:00", now, "UTC")).toBe(Date.UTC(2026, 7, 31, 20, 0, 0));
  });

  test("accepts a next-prefixed weekday", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("next fri 09:30", now, "UTC")).toBe(Date.UTC(2026, 7, 28, 9, 30, 0));
  });

  test("rejects an unknown weekday word", () => {
    const now = Date.UTC(2026, 7, 24, 17, 48, 0);
    expect(parseWhen("someday 09:30", now, "UTC")).toBeNull();
  });
});

describe("zonedWeekday", () => {
  test("reports the weekday in the given timezone", () => {
    expect(zonedWeekday(Date.UTC(2026, 7, 24, 12, 0, 0), "UTC")).toBe(1);
    expect(zonedWeekday(Date.UTC(2026, 7, 25, 1, 0, 0), "America/Los_Angeles")).toBe(1);
  });
});
