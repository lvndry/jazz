/** Exercises the durable presentation boundary against corrupt and UI-only data. */
import { describe, expect, test } from "bun:test";
import type { PresentationEntry } from "./presentation-content";
import { presentationEntrySchema } from "./presentation-content-schema";

const entry: PresentationEntry = {
  id: "receipt",
  timestamp: "2026-10-01T10:00:00.000Z",
  content: {
    kind: "tool",
    receipt: { app: "read_file", summary: "README.md", status: "ok", durationMs: 123 },
  },
};

describe("presentation entry schema", () => {
  test("accepts typed facts and removes explicit undefined optional fields", () => {
    expect(presentationEntrySchema.parse(entry)).toEqual(entry);
    const parsed = presentationEntrySchema.parse({
      ...entry,
      content: { kind: "reasoning", text: "thinking", label: "Thought", durationMs: undefined },
    });
    expect(Object.hasOwn(parsed.content, "durationMs")).toBe(false);
  });

  test("rejects unknown kinds, invalid identities, dates and nonfinite statistics", () => {
    for (const invalid of [
      { ...entry, id: "" },
      { ...entry, timestamp: "yesterday" },
      { ...entry, content: { kind: "mystery" } },
      { ...entry, content: { kind: "turn-receipt", steps: [{ durationMs: NaN }] } },
      {
        ...entry,
        content: { kind: "turn-receipt", steps: [{ durationMs: 1, tokensPerSecond: Infinity }] },
      },
      {
        ...entry,
        content: {
          kind: "report",
          report: {
            _tag: "report",
            label: "info",
            rows: [{ kind: "meter", used: -1, total: 2, caption: "bad" }],
          },
        },
      },
    ])
      expect(presentationEntrySchema.safeParse(invalid).success).toBe(false);
  });

  test("rejects prompt drafts, continuations and layout state instead of persisting them", () => {
    for (const field of [
      { secretDraft: "private" },
      { resolve: () => undefined },
      { viewport: { top: 1 } },
    ]) {
      expect(presentationEntrySchema.safeParse({ ...entry, ...field }).success).toBe(false);
      expect(
        presentationEntrySchema.safeParse({ ...entry, content: { ...entry.content, ...field } })
          .success,
      ).toBe(false);
    }
  });
});
