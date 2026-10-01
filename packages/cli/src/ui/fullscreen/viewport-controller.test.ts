/** Viewport ownership regressions: semantic identity, document revisions and adversarial transitions. */
import { describe, expect, it } from "bun:test";
import { createTranscriptLayout } from "./transcript-layout";
import { getGlyphs } from "../glyphs";
import { getThemeRevision, THEME } from "../theme";
import type { Block } from "./types";
import {
  navigateViewport,
  projectViewport,
  type ViewportInput,
  type ViewportState,
} from "./viewport-controller";

const history: Block = {
  id: "history",
  seq: 2,
  kind: "agent",
  markdown: Array.from({ length: 100 }, (_, i) => `history-${String(i).padStart(3, "0")}`).join(
    "\n\n",
  ),
};
const live: Block = {
  id: "live",
  seq: 3,
  kind: "reasoning",
  text: "one\ntwo\nthree\nfour",
  collapsed: false,
  live: true,
};
function layout(blocks: readonly Block[] = [history], width = 80, height = 10): ViewportInput {
  return {
    documentId: "main",
    index: createTranscriptLayout().update(blocks, {
      width,
      glyphs: getGlyphs(),
      themeRevision: getThemeRevision(),
      colors: THEME,
    }),
    visibleCount: height,
    width,
    occluded: false,
    submitCount: 0,
  };
}
const text = (input: ViewportInput, state: ViewportState) =>
  projectViewport(state, input).rows.map((row) => row.key);

describe("viewport controller", () => {
  it("holds identical content through repeated positive and negative live-tail deltas", () => {
    const input = layout();
    let state = navigateViewport(undefined, input, -1, "page");
    const before = text(input, state);
    for (let cycle = 0; cycle < 100; cycle++) {
      state = projectViewport(state, layout([history, live])).state;
      state = projectViewport(state, input).state;
    }
    expect(text(input, state)).toEqual(before);
    expect(projectViewport(state, input).newBelow).toBe(0);
    const down = navigateViewport(state, input, 1);
    expect(down.top).toBe(state.top + 1);
    expect(projectViewport(navigateViewport(down, input, 1, "end"), input).watchingLiveEdge).toBe(
      true,
    );
  });

  it("keeps a reading anchor when earlier reasoning expands and folds", () => {
    const old: Block = {
      id: "old",
      seq: 1,
      kind: "reasoning",
      text: "Earlier thought.\n".repeat(40),
      collapsed: true,
    };
    const input = layout([old, history]);
    const state = navigateViewport(undefined, input, -1, "page");
    const before = text(input, state);
    const expanded = layout([{ ...old, collapsed: false }, history]);
    const next = projectViewport(state, expanded);
    expect(text(expanded, next.state)).toEqual(before);
    expect(next.newBelow).toBe(0);
    expect(text(input, projectViewport(next.state, input).state)).toEqual(before);
  });

  it("preserves an unwrapped semantic character through repeated Unicode reflow", () => {
    const prose: Block = {
      id: "prose",
      seq: 1,
      kind: "agent",
      markdown: "**styled** αβ 漢字 👩‍💻 é content ".repeat(70),
    };
    const input = layout([prose], 40, 5);
    const state = navigateViewport(undefined, input, -2, "page");
    const source = state.anchor?.source;
    expect(source?.partId).toStartWith("part:");
    expect(source?.start).toBeGreaterThan(0);
    let current = state;
    for (const width of [90, 32, 120, 48, 40]) {
      const resized = layout([prose], width, 5);
      const frame = projectViewport(current, resized);
      const top = frame.rows[0]?.source;
      expect(top?.blockId).toBe(source?.blockId);
      expect(top?.partId).toBe(source?.partId);
      expect(top?.start).toBeLessThanOrEqual(source?.start ?? 0);
      expect(top?.end).toBeGreaterThan(source?.start ?? 0);
      expect(frame.newBelow).toBe(0);
      current = frame.state;
    }
    expect(current.anchor?.source).toEqual(source);
  });

  it("falls back within a collapsed block, then to a surviving neighbor on deletion", () => {
    const thought: Block = {
      id: "thought",
      seq: 1,
      kind: "reasoning",
      text: "Thought content.\n".repeat(20),
      collapsed: false,
    };
    const input = layout([thought, history]);
    const state = navigateViewport(undefined, input, -1, "end");
    const folded = projectViewport(state, layout([{ ...thought, collapsed: true }, history]));
    expect(folded.rows[0]?.source.blockId).toBe("thought");
    const deleted = projectViewport(folded.state, layout());
    expect(deleted.rows[0]?.source.blockId).toBe("history");
    expect(deleted.top).toBe(0);
  });

  it("occludes the live edge without surrendering follow intent; explicit paging opts out", () => {
    const input = layout();
    const current = projectViewport(undefined, input);
    const overlay = { ...input, occluded: true, visibleCount: 4 };
    const hidden = projectViewport(current.state, overlay);
    expect(hidden.top).toBe(current.top);
    expect(hidden.watchingLiveEdge).toBe(false);
    const grown = { ...overlay, index: layout([history, live]).index };
    const waiting = projectViewport(hidden.state, grown);
    expect(waiting.top).toBe(hidden.top);
    expect(waiting.newBelow).toBeGreaterThan(0);
    expect(projectViewport(waiting.state, { ...grown, occluded: false }).watchingLiveEdge).toBe(
      true,
    );
    const paged = navigateViewport(waiting.state, grown, -1, "page");
    expect(projectViewport(paged, { ...grown, occluded: false }).watchingLiveEdge).toBe(false);
    const zero = projectViewport(paged, { ...grown, visibleCount: 0 });
    expect(zero.rows).toHaveLength(0);
    expect(projectViewport(zero.state, input).state.anchor).toEqual(paged.anchor);
    const initialOverlay = projectViewport(undefined, overlay);
    expect(initialOverlay.top).toBe(input.index.length - overlay.visibleCount);
  });

  it("does not invent unread rows when a seen live tail disappears before reflow", () => {
    const input = layout([history, live]);
    let state = navigateViewport(undefined, input, -1, "page");
    state = projectViewport(state, layout()).state;
    const resized = projectViewport(state, layout([history], 32));
    expect(resized.newBelow).toBe(0);
  });

  it("submit returns to live and resets unseen baseline", () => {
    const input = layout();
    const detached = navigateViewport(undefined, input, -1, "page");
    const grown = { ...input, index: layout([history, live]).index };
    const submitted = projectViewport(detached, { ...grown, submitCount: 1 });
    expect(submitted.watchingLiveEdge).toBe(true);
    expect(submitted.newBelow).toBe(0);
  });

  it("keeps position bounded through a seeded sequence of churn, resize, folding and navigation", () => {
    let seed = 0x41c64e6d;
    let state: ViewportState | undefined;
    for (let index = 0; index < 500; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const input = layout(seed & 1 ? [history, live] : [history], 32 + (seed % 100), seed % 16);
      state =
        seed % 3 === 0
          ? navigateViewport(state, input, seed & 2 ? 1 : -1, "page")
          : projectViewport(state, input).state;
      const frame = projectViewport(state, input);
      expect(frame.top).toBeGreaterThanOrEqual(0);
      expect(frame.top).toBeLessThanOrEqual(Math.max(0, input.index.length - input.visibleCount));
      expect(frame.rows.length).toBeLessThanOrEqual(input.visibleCount);
      expect(frame.newBelow).toBeGreaterThanOrEqual(0);
    }
  });
});
