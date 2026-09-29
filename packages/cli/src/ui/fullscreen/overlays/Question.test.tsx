/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderForTest } from "../test-helpers";
import { MIN_HEIGHT, MIN_WIDTH, type Viewport } from "../types";
import { Question, questionLayout, type QuestionModel } from "./Question";

const WIDE: Viewport = { width: 120, height: 34 };
const COMPACT: Viewport = { width: MIN_WIDTH, height: MIN_HEIGHT };

function rows(frame: string): string[] {
  return frame.split("\n").filter((row) => row.length > 0);
}

async function draw(node: ReactNode, viewport: Viewport) {
  const setup = await renderForTest(node, { width: viewport.width, height: viewport.height });
  await setup.renderOnce();
  return setup;
}

function modelWithPreview(selected: number): QuestionModel {
  return {
    kind: "question",
    mode: "select",
    message: "Select output mode:",
    choices: [
      {
        label: "Hybrid",
        value: "hybrid",
        preview: [[{ text: "hybrid preview line" }]],
      },
      {
        label: "Raw",
        value: "raw",
        preview: [[{ text: "raw preview line" }]],
      },
    ],
    selected,
  };
}

describe("questionLayout — preview pane", () => {
  it("reserves a preview pane when any choice carries one", () => {
    const layout = questionLayout(modelWithPreview(0), WIDE);
    expect(layout.hasPreview).toBe(true);
    expect(layout.previewWidth).toBeGreaterThan(0);
    expect(layout.selectedPreview).toEqual([[{ text: "hybrid preview line" }]]);
  });

  it("tracks the currently selected choice's preview, not always the first", () => {
    const layout = questionLayout(modelWithPreview(1), WIDE);
    expect(layout.selectedPreview).toEqual([[{ text: "raw preview line" }]]);
  });

  it("has no preview pane when no choice carries one", () => {
    const layout = questionLayout(
      {
        kind: "question",
        mode: "select",
        message: "Pick one:",
        choices: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
        selected: 0,
      },
      WIDE,
    );
    expect(layout.hasPreview).toBe(false);
    expect(layout.previewWidth).toBe(0);
  });

  it("drops the preview pane rather than the list, in a viewport too narrow for both", () => {
    const layout = questionLayout(modelWithPreview(0), COMPACT);
    expect(layout.hasPreview).toBe(false);
  });
});

describe("Question — preview pane rendering", () => {
  it("paints the selected choice's preview text beside the list", async () => {
    const rendered = await draw(
      <Question
        model={modelWithPreview(0)}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("hybrid preview line");
    expect(frame).not.toContain("raw preview line");
  });

  it("swaps the preview when the selection moves", async () => {
    const rendered = await draw(
      <Question
        model={modelWithPreview(1)}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("raw preview line");
    expect(frame).not.toContain("hybrid preview line");
  });

  it("still fits every row inside the viewport with a preview pane open", async () => {
    const rendered = await draw(
      <Question
        model={modelWithPreview(0)}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(rendered.captureCharFrame());
    for (const line of lines) {
      expect([...line]).toHaveLength(WIDE.width);
    }
  });
});
