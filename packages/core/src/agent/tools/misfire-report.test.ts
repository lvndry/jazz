import { describe, expect, test } from "bun:test";
import type { MisfireEntry } from "./misfire-log";
import { buildSafeMisfireReport, misfireErrorClass } from "./misfire-report";

const entry = (overrides: Partial<MisfireEntry> = {}): MisfireEntry => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  toolName: "edit_file",
  kind: "runtime_error",
  errorMessage: "ENOENT: no such file /Users/someone/notes/draft-2.md\n    at open (node:fs:42)",
  durationMs: 12,
  ...overrides,
});

describe("misfireErrorClass", () => {
  test("keeps the first line, strips identifiers, and normalizes digits", () => {
    expect(misfireErrorClass(entry().errorMessage)).toBe("ENOENT: no such file $HOME");
    expect(misfireErrorClass("Timed out after 3000ms on attempt 2")).toBe(
      "Timed out after #ms on attempt #",
    );
  });

  test("does not treat a byte count as a phone number", () => {
    expect(misfireErrorClass("payload was 1234567890 bytes")).toBe("payload was # bytes");
  });
});

describe("buildSafeMisfireReport", () => {
  test("counts only the entries that share the first entry's tool and kind", () => {
    const report = buildSafeMisfireReport(
      [
        entry({ durationMs: 5 }),
        entry({ toolName: "web_fetch", durationMs: 900 }),
        entry({ durationMs: 20 }),
      ],
      { jazzVersion: "1.0.0", platform: "darwin" },
    );
    expect(report?.occurrences).toBe(2);
    expect(report?.durationMs).toEqual({ min: 5, max: 20 });
    expect(report?.errorClass).not.toContain("/Users/");
  });

  test("returns nothing for an empty log", () => {
    expect(
      buildSafeMisfireReport([], { jazzVersion: "1.0.0", platform: "darwin" }),
    ).toBeUndefined();
  });
});
