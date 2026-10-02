/**
 * Independent public-API QA for incremental transcript metadata. These tests
 * compare reused indexes with separately owned cold layouts and retain older
 * indexes across later updates. They inspect semantic behavior and cache bounds,
 * never private metadata structures or wall-clock performance. Run alongside
 * transcript-layout.test.ts to qualify metadata reuse through the public API.
 */
import { describe, expect, it } from "bun:test";
import { getGlyphs } from "../glyphs";
import { getThemeRevision, THEME } from "../theme";
import {
  createTranscriptLayout,
  type TranscriptLayoutEpoch,
  type TranscriptLayoutIndex,
} from "./transcript-layout";
import type { Block } from "./types";
import type { RowSource } from "./viewport-controller";

const epoch = (width = 80): TranscriptLayoutEpoch => ({
  width,
  glyphs: { ...getGlyphs() },
  themeRevision: getThemeRevision(),
  colors: { ...THEME },
});
const answer = (markdown: string, streaming = true): Block => ({
  id: "answer",
  seq: 1,
  kind: "agent",
  markdown,
  streaming,
});
const question: Block = {
  id: "question",
  seq: 0,
  kind: "user",
  text: "Investigate the result.",
};
const history = (markdown: string, streaming = true): readonly Block[] => [
  question,
  answer(markdown, streaming),
];

function probes(source: RowSource): readonly RowSource[] {
  return [source, { ...source, start: Math.max(source.start, source.end - 1) }];
}

/** A cold owner is an independent geometry oracle, including fallback behavior. */
function expectColdParity(
  actual: TranscriptLayoutIndex,
  blocks: readonly Block[],
  shape: TranscriptLayoutEpoch,
): void {
  const cold = createTranscriptLayout();
  try {
    const expected = cold.update(blocks, shape);
    expect(actual.length).toBe(expected.length);
    expect(actual.sourceAt(-1)).toBeUndefined();
    expect(actual.sourceAt(actual.length)).toBeUndefined();
    const rendered = actual.window(0, actual.length);
    expect(rendered).toEqual(expected.window(0, expected.length));
    for (let row = 0; row < expected.length; row++) {
      const source = expected.sourceAt(row);
      expect(source).toBeDefined();
      expect(actual.sourceAt(row)).toEqual(source);
      expect(actual.sourceAt(row)).toEqual(rendered[row]?.source);
      if (source === undefined) continue;
      expect(actual.hasPart(source)).toBe(expected.hasPart(source));
      expect(actual.blockBounds(source.blockId)).toEqual(expected.blockBounds(source.blockId));
      for (const probe of probes(source))
        expect(actual.sourceRow(probe)).toBe(expected.sourceRow(probe));
      const absentPart = { ...source, partId: "absent-part" };
      expect(actual.hasPart(absentPart)).toBe(false);
      expect(actual.sourceRow(absentPart)).toBe(expected.sourceRow(absentPart));
    }
    const missing = {
      blockId: "absent-block",
      partId: "absent-part",
      start: 0,
      end: 0,
    };
    expect(actual.hasPart(missing)).toBe(false);
    expect(actual.sourceRow(missing)).toBeUndefined();
    expect(actual.blockBounds(missing.blockId)).toBeUndefined();
  } finally {
    cold.dispose();
  }
}

/** Copy values now, so later mutation of a returned object cannot change the oracle. */
function snapshot(index: TranscriptLayoutIndex) {
  const sources = Array.from({ length: index.length }, (_, row) => {
    const source = index.sourceAt(row);
    return source === undefined ? undefined : { ...source };
  });
  return {
    length: index.length,
    sources,
    lookup: sources.map((source) =>
      source === undefined ? undefined : probes(source).map((probe) => index.sourceRow(probe)),
    ),
    bounds: Object.fromEntries(
      sources.flatMap((source) => {
        if (source === undefined) return [];
        const bounds = index.blockBounds(source.blockId);
        return [[source.blockId, bounds === undefined ? undefined : { ...bounds }]];
      }),
    ),
    rows: JSON.stringify(index.window(0, index.length)),
  };
}

describe("independent incremental metadata QA", () => {
  it("indexes every owner in a packed tool chunk after earlier rows shift or tool details change", () => {
    const owner = createTranscriptLayout();
    const shape = epoch(120);
    const tools: readonly Block[] = [
      {
        id: "first-tool",
        seq: 1,
        kind: "tool",
        app: "files",
        summary: "read a",
        status: "ok",
      },
      {
        id: "packed-tool",
        seq: 2,
        kind: "tool",
        app: "files",
        summary: "read b",
        status: "ok",
      },
      {
        id: "expanded-tool",
        seq: 3,
        kind: "tool",
        app: "files",
        summary: "read c",
        status: "ok",
        expanded: true,
        detail: "First detail line\nSecond detail line\nThird detail line",
      },
      {
        id: "last-tool",
        seq: 4,
        kind: "tool",
        app: "files",
        summary: "read d",
        status: "ok",
      },
    ];
    const notice: Block = {
      id: "earlier-notice",
      seq: 0,
      kind: "notice",
      tone: "info",
      text: "Earlier information wraps and moves the tool chunk. ".repeat(8),
    };
    try {
      const initial = [question, ...tools, answer("Settled answer.\n\nOpen tail")];
      const old = owner.update(initial, shape);
      const before = snapshot(old);
      const sources = new Set(old.window(0, old.length).map((row) => row.source.blockId));
      expect(sources.has("first-tool")).toBe(true);
      expect(sources.has("expanded-tool")).toBe(true);
      expect(sources.has("last-tool")).toBe(true);
      for (const blocks of [
        [question, notice, ...tools, answer("Settled answer.\n\nOpen tail grows")],
        [
          question,
          ...tools.map((block) =>
            block.kind === "tool" && block.id === "expanded-tool"
              ? { ...block, detail: "Changed details\n".repeat(10) }
              : block,
          ),
          answer("Settled answer.\n\nOpen tail grows.\n\nNew part"),
        ],
        initial,
      ]) {
        expectColdParity(owner.update(blocks, shape), blocks, shape);
        expect(snapshot(old)).toEqual(before);
      }
    } finally {
      owner.dispose();
    }
  });

  it("keeps held old indexes immutable after append, promotion, and a different stream", () => {
    const owner = createTranscriptLayout();
    const shape = epoch(48);
    try {
      const old = owner.update(history("Settled first paragraph.\n\nOpen tail 👩‍💻 é"), shape);
      const before = snapshot(old);
      for (const markdown of [
        "Settled first paragraph.\n\nOpen tail 👩‍💻 é grows",
        "Settled first paragraph.\n\nOpen tail 👩‍💻 é grows.\n\nNew part",
        "Settled first paragraph.\n\nOpen tail 👩‍💻 é grows.\n\nNew part keeps growing",
      ]) {
        const blocks = history(markdown);
        expectColdParity(owner.update(blocks, shape), blocks, shape);
        expect(snapshot(old)).toEqual(before);
      }
      owner.update(
        [
          {
            id: "another",
            seq: 2,
            kind: "agent",
            markdown: "Another stream.\n\nTail",
            streaming: true,
          },
        ],
        shape,
      );
      expect(snapshot(old)).toEqual(before);
    } finally {
      owner.dispose();
    }
  });

  it("matches cold index methods for every prefix through blank runs and Markdown parts", () => {
    const owner = createTranscriptLayout();
    const shape = epoch(42);
    const markdown =
      "Intro 👩‍💻 é words.\n\n\n## Heading\n\n- item wraps across the narrow prose measure with more words\n\n> quoted words\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nLast part";
    try {
      for (let length = 0; length <= markdown.length; length++) {
        const blocks = history(markdown.slice(0, length));
        expectColdParity(owner.update(blocks, shape), blocks, shape);
      }
      const settled = history(markdown, false);
      expectColdParity(owner.update(settled, shape), settled, shape);
    } finally {
      owner.dispose();
    }
  });

  it("invalidates same-ID settled-prefix rewrites of the same, longer, and shorter length", () => {
    const owner = createTranscriptLayout();
    const shape = epoch(42);
    const original =
      "alpha paragraph wraps through several words.\n\nSecond settled part.\n\nOpen tail";
    try {
      const old = owner.update(history(original), shape);
      const before = snapshot(old);
      for (const replacement of [
        original.replace("alpha", "omega"),
        original.replace("alpha", "a substantially longer replacement"),
        "Short changed paragraph.\n\nTail",
        original,
      ]) {
        const blocks = history(replacement);
        expectColdParity(owner.update(blocks, shape), blocks, shape);
        expect(snapshot(old)).toEqual(before);
      }
    } finally {
      owner.dispose();
    }
  });

  it("invalidates streaming geometry and palette epochs while old snapshots keep their context", () => {
    const owner = createTranscriptLayout({ cacheRows: 0 });
    const base = epoch(42);
    const markdown =
      "## Heading\n\n[linked](https://example.com) 👩‍💻 é words ".repeat(4) + "\n\nTail";
    const blocks = history(markdown);
    try {
      const old = owner.update(blocks, base);
      const before = snapshot(old);
      for (const shape of [
        { ...base, width: 120 },
        { ...base, width: 32 },
        {
          ...base,
          themeRevision: base.themeRevision + 100,
          colors: { ...base.colors, selected: "#123456", link: "#654321" },
        },
        {
          ...base,
          glyphs: { ...base.glyphs, heading2: ">>>", streamCursor: "@" },
        },
        base,
      ]) {
        expectColdParity(owner.update(blocks, shape), blocks, shape);
        expect(snapshot(old)).toEqual(before);
      }
    } finally {
      owner.dispose();
    }
  });

  it("keeps Unicode semantic offsets at grapheme boundaries after append and reflow", () => {
    const owner = createTranscriptLayout();
    const prefix = "alpha 👩‍💻 é 漢字 words ".repeat(12);
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    try {
      for (const text of [prefix, `${prefix}extra 👩‍💻 é words`]) {
        const boundaries = new Set([0, text.length]);
        for (const part of segmenter.segment(text)) {
          boundaries.add(part.index);
          boundaries.add(part.index + part.segment.length);
        }
        for (const width of [42, 90, 32, 48]) {
          const shape = epoch(width);
          const blocks = [answer(text)];
          const index = owner.update(blocks, shape);
          expectColdParity(index, blocks, shape);
          for (let row = 0; row < index.length; row++) {
            const source = index.sourceAt(row);
            expect(source?.partId).toBe("part:0");
            expect(boundaries.has(source?.start ?? -1)).toBe(true);
            expect(boundaries.has(source?.end ?? -1)).toBe(true);
          }
        }
      }
    } finally {
      owner.dispose();
    }
  });

  it("respects small cache budgets through streaming rewrites, oversize fallback, and disposal", () => {
    const owner = createTranscriptLayout({ cacheRows: 8, cacheChunks: 2 });
    const shape = epoch(48);
    let retained: TranscriptLayoutIndex | undefined;
    try {
      for (const text of [
        "small\n\nTail",
        "paragraph words\n\n".repeat(80),
        "rewritten\n\nTail",
        "```ts\n" + "const x = 1;\n".repeat(80),
      ]) {
        const blocks = history(text);
        retained = owner.update(blocks, shape);
        expectColdParity(retained, blocks, shape);
        expect(owner.stats().cachedRows).toBeLessThanOrEqual(24);
        expect(owner.stats().cachedChunks).toBeLessThanOrEqual(2);
      }
      const settled = history("Finished", false);
      retained = owner.update(settled, shape);
      expectColdParity(retained, settled, shape);
      expect(owner.stats().cachedRows).toBeLessThanOrEqual(8);
    } finally {
      owner.dispose();
    }
    expect(owner.stats()).toEqual({
      cachedRows: 0,
      cachedChunks: 0,
      sourceRows: 0,
    });
    expect(() => retained?.window(0, 1)).toThrow("disposed");
    expect(() => retained?.flatten()).toThrow("disposed");
    expect(() => owner.update(history("Late"), shape)).toThrow("disposed");
  });
});
