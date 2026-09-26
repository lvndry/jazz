import { describe, expect, it } from "bun:test";
import {
  defaultReasoningChoice,
  describeReasoningAdjustment,
  reasoningChoicesFor,
  type ResolvedReasoningControl,
} from "./reasoning";

const lowToHigh: ResolvedReasoningControl = {
  kind: "effort",
  transport: "openai-compatible.chat.reasoning-effort",
  efforts: ["low", "medium", "high"],
  canDisableReasoning: true,
};

const toggle: ResolvedReasoningControl = {
  kind: "toggle",
  transport: "openai-compatible.chat.template-enable-thinking",
  canDisableReasoning: true,
};

describe("reasoningChoicesFor", () => {
  it("offers every portable level when the control is unknown", () => {
    expect(reasoningChoicesFor({ kind: "unknown" })).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "disable",
    ]);
  });

  it("offers only listed efforts, weakest first", () => {
    expect(reasoningChoicesFor({ ...lowToHigh, efforts: ["high", "low"] })).toEqual([
      "low",
      "high",
      "disable",
    ]);
  });

  it("omits disable when the model cannot stop reasoning", () => {
    expect(reasoningChoicesFor({ ...lowToHigh, canDisableReasoning: false })).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("offers a single on level for a toggle, keeping the current effort", () => {
    expect(reasoningChoicesFor(toggle)).toEqual(["medium", "disable"]);
    expect(reasoningChoicesFor(toggle, "high")).toEqual(["high", "disable"]);
  });

  it("offers only disable for a model that does not reason", () => {
    expect(reasoningChoicesFor({ kind: "unsupported" })).toEqual(["disable"]);
  });
});

describe("defaultReasoningChoice", () => {
  it("starts on the level the current selection actually runs at", () => {
    const choices = reasoningChoicesFor(lowToHigh);
    expect(defaultReasoningChoice(choices, "max", lowToHigh)).toBe("high");
    expect(defaultReasoningChoice(choices, "disable", lowToHigh)).toBe("medium");
  });

  it("falls back to the weakest enabled level when medium is not offered", () => {
    const control = { ...lowToHigh, efforts: ["high"] } as const;
    expect(defaultReasoningChoice(reasoningChoicesFor(control), undefined, control)).toBe("high");
  });
});

describe("describeReasoningAdjustment", () => {
  it("says nothing when the model runs the selection as asked", () => {
    expect(describeReasoningAdjustment("medium", lowToHigh)).toBeUndefined();
    expect(describeReasoningAdjustment("max", { kind: "unknown" })).toBeUndefined();
  });

  it("names the level an unsupported selection runs at", () => {
    expect(describeReasoningAdjustment("max", lowToHigh)).toBe(
      "this model does not support max; it runs at high",
    );
  });

  it("explains a disable the model cannot honor", () => {
    expect(
      describeReasoningAdjustment("disable", { ...lowToHigh, canDisableReasoning: false }),
    ).toBe("this model cannot turn reasoning off; it runs at low");
    expect(describeReasoningAdjustment("disable", { ...toggle, canDisableReasoning: false })).toBe(
      "this model cannot turn reasoning off; reasoning stays on",
    );
  });
});
