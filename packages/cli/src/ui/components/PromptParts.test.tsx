import { describe, expect, it } from "bun:test";
import { renderToString } from "ink";
import { ChoiceMeta, StepperLine } from "./PromptParts";
import { initialChoiceIndex, toPickerChoices } from "../prompt-core/picker-adapter";
import { stepperView } from "../prompt-core/stepper";

const STEP = { labels: ["provider", "model", "reasoning", "persona", "name", "tools"], index: 1 };

describe("Ink prompt parts", () => {
  it("draws the same stepper the fullscreen overlay does", () => {
    const text = renderToString(<StepperLine step={STEP} />, { columns: 100 });
    expect(text).toContain("provider › model › reasoning › persona › name › tools");
    expect(text).toContain("2 of 6");
  });

  it("reads a choice's description and then its tag", () => {
    const text = renderToString(
      <ChoiceMeta
        description="400k  $1.25 / $10"
        tag="reasoning vision"
        tagTone="muted"
      />,
      { columns: 100 },
    );
    expect(text.indexOf("$1.25")).toBeLessThan(text.indexOf("reasoning vision"));
  });
});

describe("shared prompt core", () => {
  it("keeps only the current step when the trail does not fit", () => {
    expect(stepperView(STEP, 20).items).toEqual([{ label: "model", state: "current" }]);
    expect(stepperView(STEP).items.map((item) => item.state)).toEqual([
      "done",
      "current",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
  });

  it("aligns tab columns and carries tags for both renderers' pickers", () => {
    const choices = toPickerChoices([
      { label: "a", value: "a", description: "400k\t$1.25", tag: "vision", tagTone: "muted" },
      { label: "b", value: "b", description: "8k\tfree" },
    ]);
    expect(choices[0]?.description?.indexOf("$")).toBe(choices[1]?.description?.indexOf("f"));
    expect(choices[0]).toMatchObject({ tag: "vision", tagTone: "muted" });
  });
});

describe("initialChoiceIndex", () => {
  const choices = [
    { label: "coder", value: "coder" },
    { label: "default", value: "default" },
    { label: "off", value: "off", disabled: true },
  ];

  it("starts both renderers on the prompt's default", () => {
    expect(initialChoiceIndex(choices, "default")).toBe(1);
  });

  it("falls back to the first enabled choice for a missing or disabled default", () => {
    expect(initialChoiceIndex(choices, undefined)).toBe(0);
    expect(initialChoiceIndex(choices, "off")).toBe(0);
    expect(
      initialChoiceIndex([{ label: "x", value: "x", disabled: true }, ...choices], undefined),
    ).toBe(1);
  });
});
