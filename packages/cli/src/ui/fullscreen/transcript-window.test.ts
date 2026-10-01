import { describe, expect, it } from "bun:test";
import { allocateRegions, transcriptVisibleCount, wheelScrollDelta } from "./transcript-window";
import { MIN_HEIGHT, MIN_WIDTH, type InputModel, type LiveModel } from "./types";

describe("wheelScrollDelta", () => {
  it("maps trackpad up to older and down to newer", () => {
    expect(wheelScrollDelta("up", 1)).toBe(-1);
    expect(wheelScrollDelta("down", 3)).toBe(3);
    expect(wheelScrollDelta("left", 1)).toBeNull();
  });
});

describe("transcriptVisibleCount", () => {
  it("subtracts chrome, the live band, and the composer", () => {
    const live: LiveModel = { tools: [], hiddenTools: [], reservedRows: 2 };
    const input: InputModel = {
      value: "",
      placeholder: "Ask anything",
      queued: [],
      disabled: false,
    };
    expect(
      transcriptVisibleCount({
        viewport: { width: 80, height: 24 },
        live,
        input,
        inputFocused: true,
      }),
    ).toBe(15);
  });

  it("keeps a transcript row by taking it from the live band, not from the composer", () => {
    const live: LiveModel = { tools: [], hiddenTools: [], reservedRows: 5 };
    const input: InputModel = {
      value: "",
      placeholder: "Ask anything",
      queued: [],
      disabled: false,
    };
    const regions = allocateRegions({
      viewport: { width: 80, height: 8 },
      live,
      input,
      inputFocused: true,
    });

    expect(regions.input).toBe(1);
    expect(regions.transcript).toBe(1);
    // The band asked for five rows and gets what is left, not what it asked for.
    expect(regions.live).toBe(2);
  });
});

describe("allocateRegions under an overlay card", () => {
  it("ends the transcript above the card, so its last lines are never hidden", () => {
    const live: LiveModel = { tools: [], hiddenTools: [], reservedRows: 0 };
    const input: InputModel = { value: "", placeholder: "Ask", queued: [], disabled: false };
    const viewport = { width: 120, height: 34 };
    const open = allocateRegions({ viewport, live, input, inputFocused: false });
    const underCard = allocateRegions({
      viewport,
      live,
      input,
      inputFocused: false,
      overlayRows: 12,
    });
    expect(underCard.transcript).toBe(34 - 2 - 12);
    expect(underCard.transcript).toBeLessThan(open.transcript);
  });
});

describe("allocateRegions", () => {
  const live: LiveModel = { tools: [], hiddenTools: [], reservedRows: 5 };
  const commands = {
    items: Array.from({ length: 12 }, (_, index) => ({
      name: `command-${String(index)}`,
      description: "does a thing",
    })),
    selected: 0,
  };

  /**
   * Every region below the header is `flexShrink: 0`, so rows that add up to
   * more than the viewport do not compress — they push the footer off screen.
   */
  function expectFits(viewport: { width: number; height: number }, input: InputModel): void {
    const regions = allocateRegions({ viewport, live, input, inputFocused: true });
    const header = 1;
    const rule = 1;
    const gap = 1;
    const footer = 1;
    const total = header + rule + regions.transcript + regions.live + gap + regions.input + footer;
    expect(total).toBeLessThanOrEqual(viewport.height);
  }

  it("fits at the smallest supported geometry, with and without the command list", () => {
    const base: InputModel = {
      value: "",
      placeholder: "Ask anything",
      queued: [],
      disabled: false,
    };
    // The compact floor is exactly what `decideFullscreen` admits.
    expectFits({ width: MIN_WIDTH, height: MIN_HEIGHT }, base);
    expectFits({ width: MIN_WIDTH, height: MIN_HEIGHT }, { ...base, value: "/dep", commands });
    expectFits(
      { width: MIN_WIDTH, height: MIN_HEIGHT },
      { ...base, value: "x".repeat(400), queued: ["one", "two", "three"], commands },
    );
    expectFits({ width: 80, height: 24 }, { ...base, value: "/dep", commands });
  });

  it("still shows the composer and one row of the list when both are squeezed", () => {
    const input: InputModel = {
      value: "/dep",
      placeholder: "Ask anything",
      queued: [],
      disabled: false,
      commands,
    };
    const regions = allocateRegions({
      viewport: { width: MIN_WIDTH, height: MIN_HEIGHT },
      live,
      input,
      inputFocused: true,
    });

    expect(regions.input).toBeGreaterThanOrEqual(2);
    expect(regions.transcript).toBeGreaterThanOrEqual(1);
  });
});
