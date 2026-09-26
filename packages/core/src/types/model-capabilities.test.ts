import { describe, expect, it } from "bun:test";
import { clampReasoningSelection, type ReasoningControlSurface } from "./model-capabilities";

const lowToHigh: ReasoningControlSurface = {
  kind: "effort",
  transport: "openai-compatible.chat.reasoning-effort",
  efforts: ["low", "medium", "high"],
  canDisable: true,
};

describe("clampReasoningSelection", () => {
  it("keeps a listed effort", () => {
    expect(clampReasoningSelection("medium", lowToHigh)).toBe("medium");
  });

  it("lowers an unlisted effort to the nearest weaker listed one", () => {
    expect(clampReasoningSelection("max", lowToHigh)).toBe("high");
    expect(clampReasoningSelection("xhigh", { ...lowToHigh, efforts: ["low", "medium"] })).toBe(
      "medium",
    );
  });

  it("raises to the weakest listed effort only when nothing weaker is listed", () => {
    expect(clampReasoningSelection("minimal", lowToHigh)).toBe("low");
  });

  it("turns disable into the weakest effort when the model cannot stop reasoning", () => {
    expect(clampReasoningSelection("disable", { ...lowToHigh, canDisable: false })).toBe("low");
    expect(
      clampReasoningSelection("disable", {
        kind: "toggle",
        transport: "openai-compatible.chat.template-enable-thinking",
        canDisable: false,
      }),
    ).toBe("minimal");
  });

  it("keeps disable when the model can stop reasoning", () => {
    expect(clampReasoningSelection("disable", lowToHigh)).toBe("disable");
  });

  it("leaves the selection alone when there is no ladder to fit it to", () => {
    expect(clampReasoningSelection("max", { kind: "unknown" })).toBe("max");
    expect(clampReasoningSelection("max", { kind: "unsupported" })).toBe("max");
    expect(clampReasoningSelection(undefined, lowToHigh)).toBeUndefined();
  });
});
