/** @jsxImportSource @opentui/react */
/// <reference types="bun-types/test" />

/**
 * Renders scrollable command reports as terminal frames, checking that the
 * scrollbar cannot hide the end of a summary or make tool groups unreachable.
 */
import { expect, test } from "bun:test";
import { useState } from "react";
import { getGlyphs } from "../../glyphs";
import { renderForTest, updateForTest } from "../test-helpers";
import type { CommandPanelOverlay, Viewport } from "../types";
import { CommandPanel, commandPanelLayout } from "./CommandPanel";

const model: CommandPanelOverlay = {
  kind: "panel",
  offset: 0,
  panel: {
    id: 1,
    command: "/tools",
    entries: [
      {
        kind: "report",
        report: {
          _tag: "report",
          label: "tools",
          rows: [
            ...Array.from({ length: 35 }, (_, index) => ({
              kind: "item" as const,
              name: `tool_${String(index)}`,
            })),
            { kind: "group", label: "Peers", count: "2" },
            { kind: "item", name: "ask_peer" },
            { kind: "item", name: "request_clarification" },
            ...Array.from({ length: 36 }, (_, index) => ({
              kind: "item" as const,
              name: `other_tool_${String(index)}`,
            })),
          ],
          note: "chatgpt-sol has 73 tools in 19 groups.",
        },
      },
    ],
  },
};

async function renderAtOffset(viewport: Viewport, target: number) {
  let scrollTo: (offset: number) => void = () => {
    throw new Error("panel is not mounted");
  };
  function Panel() {
    const [offset, setOffset] = useState(0);
    scrollTo = setOffset;
    return (
      <CommandPanel
        model={{ ...model, offset }}
        viewport={viewport}
      />
    );
  }
  const rendered = await renderForTest(<Panel />, viewport);
  await rendered.renderOnce();
  updateForTest(() => scrollTo(target));
  await rendered.flush();
  return rendered;
}

test("shows the full tools summary at the bottom of a scrollable panel", async () => {
  const viewport: Viewport = { width: 100, height: 24 };
  const layout = commandPanelLayout(model, viewport, getGlyphs());
  const rendered = await renderAtOffset(viewport, layout.maxOffset);
  try {
    expect(rendered.captureCharFrame()).toContain("chatgpt-sol has 73 tools in 19 groups.");
  } finally {
    rendered.renderer.destroy();
  }
});

test.each([
  { width: 80, height: 24 },
  { width: 48, height: 18 },
  { width: 32, height: 10 },
])("keeps the last summary word reachable at $width by $height", async (viewport) => {
  const layout = commandPanelLayout(model, viewport, getGlyphs());
  const rendered = await renderAtOffset(viewport, layout.maxOffset);
  try {
    expect(rendered.captureCharFrame()).toContain("groups.");
  } finally {
    rendered.renderer.destroy();
  }
});

test("reveals the Peers group and both tools when scrolled to them", async () => {
  const viewport: Viewport = { width: 100, height: 24 };
  const layout = commandPanelLayout(model, viewport, getGlyphs());
  const offset = layout.rows.findIndex((row) =>
    row.some((segment) => segment.text.includes("Peers")),
  );
  const rendered = await renderAtOffset(viewport, offset);
  try {
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Peers");
    expect(frame).toContain("ask_peer");
    expect(frame).toContain("request_clarification");
  } finally {
    rendered.renderer.destroy();
  }
});
