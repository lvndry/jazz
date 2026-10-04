/** Exercises the durable presentation boundary against corrupt and UI-only data. */
import { describe, expect, test } from "bun:test";
import type { PresentationContent, PresentationEntry } from "./presentation-content";
import { presentationEntrySchema } from "./presentation-content-schema";
import type { ReportRow } from "../interfaces/terminal";

/** Every optional field made required, recursively, so a fixture must name each one. */
type Complete<T> = T extends readonly (infer Item)[]
  ? readonly Complete<Item>[]
  : T extends object
    ? { [Key in keyof T]-?: Complete<T[Key]> }
    : T;

type ByKind<Union extends { kind: string }> = {
  [Kind in Union["kind"]]: Complete<Extract<Union, { kind: Kind }>>;
};

/**
 * One fully populated value per kind. A field added to a presentation type without a
 * fixture here fails typecheck; one added here without the schema fails the parse below,
 * instead of every save of a conversation that produced it failing at runtime.
 */
const everyReportRow: ByKind<ReportRow> = {
  field: { kind: "field", key: "model", value: "gpt", tone: "accent", detail: "default" },
  item: { kind: "item", name: "agent", detail: "idle", marker: "current", tone: "muted" },
  meter: { kind: "meter", used: 1, total: 2, caption: "half" },
  text: { kind: "text", text: "line", tone: "text" },
  group: { kind: "group", label: "Agents", count: "2" },
  gap: { kind: "gap" },
};

const everyContent: ByKind<PresentationContent> = {
  user: { kind: "user", text: "hello" },
  agent: { kind: "agent", markdown: "**hi**" },
  reasoning: {
    kind: "reasoning",
    text: "thinking",
    label: "Thought",
    durationMs: 10,
    steps: 2,
    tokens: 30,
  },
  tool: {
    kind: "tool",
    receipt: {
      app: "edit_file",
      summary: "README.md",
      status: "ok",
      args: "README.md",
      durationMs: 12,
      reason: "denied by policy",
      notDone: "README.md was not changed",
      remedyKey: "retry",
      detail: "1 line changed",
      outputPreview: "done",
      classifiedRisk: "low",
      diffPreview: { lines: ["-a", "+b"], hiddenLines: 0 },
      diffText: "-a\n+b",
    },
  },
  notice: { kind: "notice", text: "saved", tone: "info", audience: "classic" },
  report: {
    kind: "report",
    report: { _tag: "report", label: "info", rows: Object.values(everyReportRow), note: "n" },
  },
  header: { kind: "header", name: "jazz", provider: "openai", model: "gpt" },
  "turn-receipt": {
    kind: "turn-receipt",
    steps: [
      {
        durationMs: 100,
        generationDurationMs: 80,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 2,
        costUSD: 0.01,
        tokensPerSecond: 62.5,
      },
    ],
  },
  stopped: { kind: "stopped", summary: { elapsedMs: 5, done: ["a"], notDone: ["b"] } },
  expanded: { kind: "expanded", text: "full output" },
};

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

  test("accepts every field the presentation types declare", () => {
    for (const content of Object.values(everyContent)) {
      const candidate = { ...entry, content };
      expect(presentationEntrySchema.safeParse(candidate).error?.issues).toBeUndefined();
      expect(presentationEntrySchema.parse(candidate)).toEqual(candidate);
    }
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
