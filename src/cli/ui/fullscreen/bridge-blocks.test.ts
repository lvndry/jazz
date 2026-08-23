import { describe, expect, it } from "bun:test";
import type { EphemeralRegion } from "../store";
import type { OutputEntry } from "../types";
import { blocksFrom, shareUnchangedBlocks, transcriptBlocks } from "./bridge";

const USER: OutputEntry = {
  id: "u1",
  type: "user",
  message: "what is on Thursday",
  timestamp: new Date("2026-08-23T12:00:00.000Z"),
};

const AGENT: OutputEntry = {
  id: "a1",
  type: "streamContent",
  message: "Thursday is free after 3.",
  timestamp: new Date("2026-08-23T12:00:01.000Z"),
};

const EMPTY_REGIONS: readonly EphemeralRegion[] = [];

describe("transcript block identity", () => {
  it("incrementing tick or editing draft does not change blocks referential identity", () => {
    const sources = { outputs: [USER, AGENT], streaming: "", regions: EMPTY_REGIONS };
    const first = { tick: 1, draft: "", blocks: transcriptBlocks(sources) };
    const afterTick = {
      tick: first.tick + 1,
      draft: first.draft,
      blocks: transcriptBlocks(sources, first.blocks),
    };
    const afterDraft = {
      tick: afterTick.tick,
      draft: `${first.draft}hello`,
      blocks: transcriptBlocks(sources, afterTick.blocks),
    };
    expect(afterTick.tick).not.toBe(first.tick);
    expect(afterDraft.draft).not.toBe(first.draft);
    expect(afterTick.blocks).toBe(first.blocks);
    expect(afterDraft.blocks).toBe(first.blocks);
    expect(afterDraft.blocks[0]).toBe(first.blocks[0]);
    expect(afterDraft.blocks[1]).toBe(first.blocks[1]);
  });

  it("reuses unchanged Block objects when streaming grows", () => {
    const settled = transcriptBlocks({
      outputs: [USER, AGENT],
      streaming: "",
      regions: EMPTY_REGIONS,
    });
    const streaming = transcriptBlocks(
      { outputs: [USER, AGENT], streaming: " and Friday too.", regions: EMPTY_REGIONS },
      settled,
    );
    expect(streaming).not.toBe(settled);
    expect(streaming[0]).toBe(settled[0]);
    expect(streaming[1]).toBe(settled[1]);
    expect(streaming.at(-1)?.kind).toBe("agent");
    expect(streaming.at(-1)).not.toBe(settled.at(-1));
  });

  it("does not write live reasoning duration onto a Block", () => {
    const regions: readonly EphemeralRegion[] = [
      {
        id: "r-live",
        kind: "reasoning",
        label: "Reasoning",
        startedAt: Date.now() - 4_000,
        tail: ["weighing the two calendars"],
        maxLines: 8,
      },
    ];
    const first = transcriptBlocks({ outputs: [], streaming: "", regions });
    const later = transcriptBlocks({ outputs: [], streaming: "", regions }, first);
    expect(later).toBe(first);
    const reasoning = later.find((block) => block.kind === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning?.kind === "reasoning" ? reasoning.durationMs : "missing").toBeUndefined();
    expect(reasoning?.kind === "reasoning" ? reasoning.text : "").toBe(
      "weighing the two calendars",
    );
  });

  it("shareUnchangedBlocks returns the previous array when every block is reused", () => {
    const next = blocksFrom([USER], "", EMPTY_REGIONS);
    const previous = shareUnchangedBlocks([], next);
    expect(shareUnchangedBlocks(previous, blocksFrom([USER], "", EMPTY_REGIONS))).toBe(previous);
  });
});
