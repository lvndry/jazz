/** Prove bounded row retention, compact source lookup, incremental reuse and epoch isolation. */
import { describe, expect, it } from "bun:test";
import { getGlyphs } from "../glyphs";
import { getThemeRevision, setThemeVariant, THEME } from "../theme";
import { createTranscriptLayout, type TranscriptLayoutEpoch } from "./transcript-layout";
import type { Block } from "./types";

const epoch = (width = 80): TranscriptLayoutEpoch => ({
  width,
  glyphs: getGlyphs(),
  themeRevision: getThemeRevision(),
  colors: THEME,
});
const agent = (id: string, markdown: string, streaming = false): Block => ({
  id,
  seq: 1,
  kind: "agent",
  markdown,
  streaming,
});

describe("instance-owned transcript layout", () => {
  it("rejects budgets that would defeat bounded cache ownership", () => {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createTranscriptLayout({ cacheRows: value })).toThrow(RangeError);
      expect(() => createTranscriptLayout({ cacheChunks: value })).toThrow(RangeError);
    }
  });

  it("retains heights and semantic positions while bounding painted rows across long history", () => {
    const layout = createTranscriptLayout({ cacheRows: 64, cacheChunks: 4 });
    const blocks = Array.from({ length: 300 }, (_, index) =>
      agent(`a${index}`, "paragraph words ".repeat(50)),
    );
    const index = layout.update(blocks, epoch());
    expect(index.length).toBeGreaterThan(3000);
    for (const top of [0, 25, 800, 1300, index.length - 20]) {
      const selected = index.window(top, 20);
      expect(selected).toHaveLength(20);
      for (let row = 0; row < selected.length; row++)
        expect(selected[row]?.source).toEqual(index.sourceAt(top + row));
      expect(layout.stats().cachedRows).toBeLessThanOrEqual(64);
      expect(layout.stats().cachedChunks).toBeLessThanOrEqual(4);
    }
    const source = index.sourceAt(1300);
    expect(source).toBeDefined();
    if (source !== undefined) expect(index.sourceRow(source)).toBe(1300);
    expect(layout.stats().sourceRows).toBe(index.length);
    layout.dispose();
    expect(layout.stats()).toEqual({ cachedRows: 0, cachedChunks: 0, sourceRows: 0 });
  });

  it("measures unchanged chunks once per epoch and reuses only a dirty tail", () => {
    let reads = 0;
    const stable: Block = {
      id: "settled",
      seq: 1,
      kind: "agent",
      get markdown() {
        reads++;
        return "settled paragraph";
      },
    };
    const layout = createTranscriptLayout();
    const first = layout.update([stable], epoch());
    const firstRow = first.window(0, 1)[0];
    const settledReads = reads;
    layout.update([stable, agent("tail", "one", true)], epoch());
    const after = layout.update([stable, agent("tail", "one two", true)], epoch());
    expect(after.window(0, 1)[0]).toBe(firstRow);
    expect(reads).toBe(settledReads);
    layout.update([stable], epoch(100));
    expect(reads).toBeGreaterThan(settledReads);
  });

  it("retires retained indexes so late reads cannot resurrect disposed caches", () => {
    const layout = createTranscriptLayout();
    const blocks = [agent("retired", "old paragraph", true)];
    const retired = layout.update(blocks, epoch());
    layout.dispose();
    expect(() => retired.window(0, 2)).toThrow("disposed");
    expect(() => retired.flatten()).toThrow("disposed");
    expect(() => layout.update(blocks, epoch())).toThrow("disposed");
    expect(layout.stats()).toEqual({ cachedRows: 0, cachedChunks: 0, sourceRows: 0 });
  });

  it("keeps an oversized chunk outside the LRU while returning an exact bounded window", () => {
    const layout = createTranscriptLayout({ cacheRows: 16, cacheChunks: 2 });
    const block = agent(
      "huge",
      Array.from({ length: 1000 }, (_, i) => `paragraph ${i}`).join("\n\n"),
    );
    const index = layout.update([block], epoch());
    expect(index.length).toBe(1999);
    expect(layout.stats().cachedRows).toBe(0);
    const selected = index.window(1600, 12);
    expect(selected).toHaveLength(12);
    expect(selected[0]?.content[0]?.text).toBe("paragraph 800");
    expect(layout.stats().cachedRows).toBe(0);
    expect(layout.stats().cachedChunks).toBe(0);
  });

  it("bounds streamed prose and fence prefixes and releases them when the turn settles", () => {
    const layout = createTranscriptLayout({ cacheRows: 8, cacheChunks: 2 });
    for (const markdown of [
      "paragraph\n\n".repeat(100),
      `\`\`\`ts\n${"const value = 1;\n".repeat(100)}`,
    ]) {
      const index = layout.update([agent("live", markdown, true)], epoch());
      index.window(index.length - 4, 4);
      expect(layout.stats().cachedRows).toBeLessThanOrEqual(24);
    }
    layout.update([agent("done", "finished")], epoch());
    expect(layout.stats().cachedRows).toBe(1);
    layout.dispose();
    expect(layout.stats().cachedRows).toBe(0);
  });

  it("realizes old indexes with their captured palette after another theme or view changes", () => {
    setThemeVariant("dark");
    const dark = { ...THEME };
    const blocks = [agent("code", "[linked](https://example.com)\n\n```ts\nconst value = 1;\n```")];
    const left = createTranscriptLayout({ cacheRows: 0 });
    const old = left.update(blocks, epoch());
    const expected = old.flatten();
    try {
      setThemeVariant("light");
      const right = createTranscriptLayout({ cacheRows: 0 });
      const light = right.update(blocks, epoch(120)).window(0, 100);
      expect(light.flatMap((row) => row.content).some((span) => span.fg === THEME.link)).toBe(true);
      left.update(blocks, epoch());
      const retained = old.window(0, old.length);
      expect(retained).toEqual(expected);
      expect(
        retained.flatMap((row) => row.content).some((span) => span.fg === dark.syntaxStructure),
      ).toBe(true);
      expect(right.stats().cachedRows).toBe(0);
    } finally {
      setThemeVariant("dark");
    }
  });

  it("invalidates every glyph field and keeps independent view geometry", () => {
    const block: Block = { id: "user", seq: 0, kind: "user", text: "text" };
    const left = createTranscriptLayout();
    const right = createTranscriptLayout();
    const leftEpoch = epoch(80);
    const old = left.update([block], leftEpoch);
    const custom = { ...epoch(120), glyphs: { ...getGlyphs(), bandBar: "!" } };
    const changed = left.update([block], custom);
    const other = right.update([block], leftEpoch);
    expect(changed.window(0, 3).some((row) => row.gutter.some((span) => span.text === "!"))).toBe(
      true,
    );
    expect(other.window(0, 3)).toEqual(old.window(0, 3));
    expect(changed.window(0, 3)[0]?.contentWidth).not.toBe(other.window(0, 3)[0]?.contentWidth);
  });
});
