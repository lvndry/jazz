/** @jsxImportSource @opentui/react */

/**
 * The pieces the create-agent wizard adds to the question and text overlays: the stepper row,
 * right-aligned tags, and description columns that line up across choices.
 */

import { describe, expect, it } from "bun:test";
import { renderForTest } from "../test-helpers";
import { alignDescriptionColumns, Question, type QuestionModel } from "./Question";
import { stepperSegments } from "./stepper";
import { TextPrompt } from "./TextPrompt";
import { getGlyphs } from "../../glyphs";
import { THEME } from "../../theme";
import type { Viewport } from "../types";

const VIEWPORT: Viewport = { width: 100, height: 30 };
const STEP = { labels: ["provider", "model", "reasoning", "persona", "name", "tools"], index: 1 };

async function draw(node: Parameters<typeof renderForTest>[0]): Promise<string> {
  const { renderOnce, captureCharFrame, renderer } = await renderForTest(node, VIEWPORT);
  await renderOnce();
  const text = captureCharFrame();
  renderer.destroy();
  return text;
}

describe("stepperSegments", () => {
  it("marks done steps, puts the current one in the accent, and counts them", () => {
    const check = getGlyphs().success;
    const segments = stepperSegments(STEP, 80, check);
    const text = segments.map((segment) => segment.text).join("");
    expect(text.startsWith(`${check} provider › model › reasoning`)).toBe(true);
    expect(text.trimEnd().endsWith("2 of 6")).toBe(true);
    expect(segments.find((segment) => segment.text === "model")).toMatchObject({
      fg: THEME.primary,
      bold: true,
    });
    expect([...text]).toHaveLength(80);
  });

  it("keeps the current step and the count when the trail does not fit", () => {
    const text = stepperSegments(STEP, 20, getGlyphs().success)
      .map((segment) => segment.text)
      .join("");
    expect(text.startsWith("model")).toBe(true);
    expect(text.endsWith("2 of 6")).toBe(true);
  });
});

describe("alignDescriptionColumns", () => {
  it("lines tab-separated cells up across choices", () => {
    const aligned = alignDescriptionColumns([
      { label: "a", value: "a", description: "400k\t$1.25 / $10" },
      { label: "b", value: "b", description: "8k\tfree" },
      { label: "c", value: "c" },
    ]);
    const first = aligned[0]?.description ?? "";
    const second = aligned[1]?.description ?? "";
    expect(first.indexOf("$")).toBe(second.indexOf("f"));
    expect(aligned[2]?.description).toBeUndefined();
  });

  it("leaves descriptions without tabs untouched", () => {
    const choices = [{ label: "a", value: "a", description: "plain  text" }];
    expect(alignDescriptionColumns(choices)).toBe(choices);
  });
});

describe("wizard prompts", () => {
  it("draws the stepper, tags and aligned columns in the question overlay", async () => {
    const model: QuestionModel = {
      kind: "question",
      mode: "select",
      message: "Which model?",
      choices: [
        {
          label: "gpt-5.6-sol",
          value: "choice-0",
          description: "400k\t$1.25 / $10",
          tag: "reasoning vision",
          tagTone: "muted",
        },
        { label: "gpt-5.4-mini", value: "choice-1", description: "128k\t$0.15 / $0.6" },
      ],
      selected: 0,
      filterable: true,
      filter: "",
      filterCaret: 0,
      step: STEP,
    };
    const text = await draw(
      <Question
        model={model}
        viewport={VIEWPORT}
      />,
    );
    expect(text).toContain("model › reasoning");
    expect(text).toContain("2 of 6");
    const rows = text.split("\n");
    const sol = rows.find((row) => row.includes("gpt-5.6-sol")) ?? "";
    const mini = rows.find((row) => row.includes("gpt-5.4-mini")) ?? "";
    expect(sol).toContain("reasoning vision");
    expect(sol.indexOf("$1.25")).toBe(mini.indexOf("$0.15"));
  });

  it("draws the stepper above a text prompt", async () => {
    const text = await draw(
      <TextPrompt
        model={{
          kind: "text",
          message: "What should we call it?",
          value: "sol",
          caret: 3,
          step: { ...STEP, index: 4 },
        }}
        viewport={VIEWPORT}
      />,
    );
    expect(text).toContain("5 of 6");
    const rows = text.split("\n");
    const stepper = rows.findIndex((row) => row.includes("5 of 6"));
    const question = rows.findIndex((row) => row.includes("What should we call it?"));
    expect(stepper).toBeLessThan(question);
  });
});
