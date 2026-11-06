import { describe, expect, test } from "bun:test";
import { nextCronRun } from "./cron";
import { parseTimeZone, resolveUserZone } from "./user-time-zone";

describe("parseTimeZone", () => {
  test("accepts an IANA name and returns its canonical spelling", () => {
    expect(parseTimeZone("europe/paris")).toEqual({ ok: true, zone: "Europe/Paris" });
    expect(parseTimeZone(" America/New_York ")).toEqual({ ok: true, zone: "America/New_York" });
    expect(parseTimeZone("UTC").ok).toBe(true);
  });

  test.each(["", "Paris", "+02:00", "EST5EDT garbage", "Mars/Olympus_Mons", "../etc"])(
    "rejects %p with a message naming the input",
    (name) => {
      const parsed = parseTimeZone(name);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain(`"${name}"`);
      }
    },
  );
});

describe("resolveUserZone", () => {
  test("a zone named in the message wins over the chat setting and config", () => {
    expect(
      resolveUserZone({
        explicit: "Asia/Tokyo",
        chatSetting: "Europe/Paris",
        userConfig: "America/Chicago",
        hostIsUserDevice: true,
      }),
    ).toEqual({ kind: "known", zone: "Asia/Tokyo", source: "explicit-in-message" });
  });

  test("falls through chat setting, user config, then the interactive host", () => {
    expect(resolveUserZone({ chatSetting: "Europe/Paris", hostIsUserDevice: false })).toEqual({
      kind: "known",
      zone: "Europe/Paris",
      source: "chat-setting",
    });
    expect(resolveUserZone({ userConfig: "Europe/Paris", hostIsUserDevice: false })).toEqual({
      kind: "known",
      zone: "Europe/Paris",
      source: "user-config",
    });
    expect(resolveUserZone({ hostIsUserDevice: true, hostZone: "Europe/Rome" })).toEqual({
      kind: "known",
      zone: "Europe/Rome",
      source: "interactive-host",
    });
  });

  test("a host that is not the user's device is never an answer", () => {
    expect(resolveUserZone({ hostIsUserDevice: false, hostZone: "Europe/Rome" })).toEqual({
      kind: "unknown",
    });
  });

  test("an invalid candidate is skipped, not guessed at", () => {
    expect(resolveUserZone({ explicit: "nowhere", hostIsUserDevice: false })).toEqual({
      kind: "unknown",
    });
    expect(
      resolveUserZone({
        explicit: "nowhere",
        chatSetting: "Europe/Paris",
        hostIsUserDevice: false,
      }),
    ).toMatchObject({ kind: "known", source: "chat-setting" });
  });
});

describe("a stored cron schedule keeps its zone", () => {
  const after = new Date("2026-01-05T00:00:00Z");

  test("the same instant under any host zone", () => {
    const originalZone = process.env["TZ"];
    try {
      const results = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map((hostZone) => {
        process.env["TZ"] = hostZone;
        return nextCronRun("0 9 * * *", after, "Europe/Paris")?.toISOString();
      });
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe("2026-01-05T08:00:00.000Z");
    } finally {
      if (originalZone === undefined) {
        delete process.env["TZ"];
      } else {
        process.env["TZ"] = originalZone;
      }
    }
  });

  test("a schedule stored without a zone is read in UTC, not the host zone", () => {
    const originalZone = process.env["TZ"];
    try {
      process.env["TZ"] = "Asia/Tokyo";
      expect(nextCronRun("0 9 * * *", after)?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
    } finally {
      if (originalZone === undefined) {
        delete process.env["TZ"];
      } else {
        process.env["TZ"] = originalZone;
      }
    }
  });
});
