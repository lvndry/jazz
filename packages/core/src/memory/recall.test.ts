import { describe, test, expect } from "bun:test";
import {
  buildMemoryIndex,
  classifyActiveWorkflows,
  collectWorkflows,
  selectRecall,
  type MemoryIndexEntry,
} from "./recall";
import type { MemoryFileProvenance } from "../interfaces/memory-provenance";

function record(fields: Partial<MemoryFileProvenance> = {}): MemoryFileProvenance {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    writeCount: 1,
    writtenBy: ["agent-1"],
    ...fields,
  };
}

function entry(fields: Partial<MemoryIndexEntry> & { path: string }): MemoryIndexEntry {
  return {
    kind: "preference",
    workflow: undefined,
    subject: undefined,
    summary: "",
    ...fields,
  };
}

describe("buildMemoryIndex", () => {
  test("reads kind and workflow off the path rather than the record", () => {
    const index = buildMemoryIndex("personal", {
      "preferences/_global/auto-open.md": record({ summary: "auto-open renders" }),
      "lessons/moodboard/scaling.md": record({ summary: "artboards auto-scale" }),
      "facts/timezone.md": record({ summary: "lives in Paris" }),
    });

    expect(index.map((item) => [item.path, item.kind, item.workflow])).toEqual([
      ["personal/facts/timezone.md", "fact", undefined],
      ["personal/lessons/moodboard/scaling.md", "lesson", "moodboard"],
      ["personal/preferences/_global/auto-open.md", "preference", undefined],
    ]);
  });

  test("skips untyped legacy entries, which have no kind to route on", () => {
    const index = buildMemoryIndex("personal", { "notes.md": record({ summary: "old note" }) });
    expect(index).toEqual([]);
  });

  test("leaves the summary unset when the store never derived one", () => {
    const index = buildMemoryIndex("personal", { "facts/home-timezone.md": record() });
    expect(index[0]?.summary).toBeUndefined();
  });

  test("never injects a preference whose summary is unknown", () => {
    const index = buildMemoryIndex("personal", { "preferences/_global/a.md": record() });
    expect(selectRecall({ entries: index, requestText: "anything" }).preferences).toEqual([]);
  });
});

describe("classifyActiveWorkflows", () => {
  const entries = [
    entry({ path: "p/lessons/moodboard/a.md", kind: "lesson", workflow: "moodboard" }),
    entry({ path: "p/lessons/invoicing/b.md", kind: "lesson", workflow: "invoicing" }),
  ];

  test("activates a workflow named in the request", () => {
    expect(classifyActiveWorkflows("make me a moodboard for the pitch", entries)).toEqual([
      "moodboard",
    ]);
  });

  test("ignores workflows the request does not mention", () => {
    expect(classifyActiveWorkflows("fix the invoicing script", entries)).toEqual(["invoicing"]);
  });

  test("matches a hyphenated tag written as one word", () => {
    const hyphenated = [
      entry({ path: "p/lessons/mood-board/a.md", kind: "lesson", workflow: "mood-board" }),
    ];
    expect(classifyActiveWorkflows("build a moodboard", hyphenated)).toEqual(["mood-board"]);
  });

  test("does not depend on the working directory, only the request", () => {
    expect(classifyActiveWorkflows("", entries)).toEqual([]);
  });
});

describe("collectWorkflows", () => {
  test("returns distinct tags, excluding global entries", () => {
    expect(
      collectWorkflows([
        entry({ path: "a", workflow: "moodboard" }),
        entry({ path: "b", workflow: "moodboard" }),
        entry({ path: "c", workflow: undefined }),
      ]),
    ).toEqual(["moodboard"]);
  });
});

describe("selectRecall", () => {
  const globalPreference = entry({
    path: "personal/preferences/_global/auto-open.md",
    kind: "preference",
    subject: "rendered-output-opening",
    summary: "auto-open rendered output when a task finishes",
  });
  const moodboardPreference = entry({
    path: "personal/preferences/moodboard/scaling.md",
    kind: "preference",
    workflow: "moodboard",
    subject: "artboard-scaling",
    summary: "fixed artboards auto-scale and stay centered",
  });
  const invoicingPreference = entry({
    path: "personal/preferences/invoicing/vat.md",
    kind: "preference",
    workflow: "invoicing",
    subject: "vat-rate",
    summary: "always include the VAT line",
  });

  const entries = [globalPreference, moodboardPreference, invoicingPreference];

  test("always injects a global preference regardless of the request", () => {
    const selection = selectRecall({ entries, requestText: "what time is it" });
    expect(selection.preferences.map((item) => item.path)).toEqual([globalPreference.path]);
  });

  test("adds a workflow preference when that work is active", () => {
    const selection = selectRecall({ entries, requestText: "build me a moodboard" });
    expect(selection.preferences.map((item) => item.path)).toEqual([
      globalPreference.path,
      moodboardPreference.path,
    ]);
    expect(selection.activeWorkflows).toEqual(["moodboard"]);
  });

  test("changes only when the active workflow changes, not on every request", () => {
    const first = selectRecall({ entries, requestText: "tweak the moodboard spacing" });
    const second = selectRecall({ entries, requestText: "redo this moodboard" });
    expect(first.preferences).toEqual(second.preferences);
  });

  test("recalls a workflow preference wherever that work happens, not per folder", () => {
    for (const request of [
      "moodboard for the pitch",
      "redo this moodboard",
      "a moodboard please",
    ]) {
      expect(
        selectRecall({ entries, requestText: request }).preferences.map((item) => item.path),
      ).toContain(moodboardPreference.path);
    }
  });

  test("leaves out preferences for workflows that are not active", () => {
    const selection = selectRecall({ entries, requestText: "build me a moodboard" });
    const selected = [...selection.preferences, ...selection.ranked].map((item) => item.path);
    expect(selected).not.toContain(invoicingPreference.path);
  });

  test("caps the standing set so an always-on injection cannot grow unbounded", () => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      entry({ path: `personal/preferences/_global/p${index}.md`, kind: "preference" }),
    );
    expect(
      selectRecall({ entries: many, requestText: "hi", maxStanding: 3 }).preferences,
    ).toHaveLength(3);
  });

  test("ranks a lesson whose wording appears in the request", () => {
    const lesson = entry({
      path: "personal/lessons/_global/artboard.md",
      kind: "lesson",
      summary: "artboards must scale proportionally",
    });
    const selection = selectRecall({
      entries: [lesson],
      requestText: "the artboards look wrong",
    });
    expect(selection.ranked.map((item) => item.path)).toEqual([lesson.path]);
  });

  test("does not rank an entry with nothing in common with the request", () => {
    const fact = entry({
      path: "personal/facts/timezone.md",
      kind: "fact",
      summary: "lives in Paris",
    });
    const selection = selectRecall({ entries: [fact], requestText: "rename this variable" });
    expect(selection.ranked).toEqual([]);
  });

  test("never repeats a standing preference in the contextual set", () => {
    const selection = selectRecall({
      entries,
      requestText: "moodboard artboards rendered output",
    });
    const contextualPaths = selection.ranked.map((item) => item.path);
    for (const standing of selection.preferences) {
      expect(contextualPaths).not.toContain(standing.path);
    }
  });
});
