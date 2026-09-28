import { report } from "@jazz/core/interfaces/terminal";
import { describe, expect, it } from "bun:test";
import type { EphemeralRegion } from "../store";
import type { OutputEntry } from "../types";
import { blocksFrom, shareUnchangedBlocks, transcriptBlocks, waitingLabel } from "./bridge";

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

describe("agent prose hyperlinks", () => {
  it("keeps the target of a formatted link so the transcript can make it clickable", () => {
    const formatted = "See \x1b]8;;https://example.com/guide\x07the guide\x1b]8;;\x07.";
    const entry: OutputEntry = { ...AGENT, message: formatted };
    const [block] = blocksFrom([entry], "", EMPTY_REGIONS);
    expect(block).toMatchObject({
      kind: "agent",
      markdown: "See [the guide](https://example.com/guide).",
    });
  });

  it("keeps link targets in the turn still streaming", () => {
    const streaming = "\x1b]8;;https://example.com\x07site\x1b]8;;\x07";
    const [block] = blocksFrom([], streaming, EMPTY_REGIONS);
    expect(block).toMatchObject({ kind: "agent", markdown: "[site](https://example.com)" });
  });
});

describe("conversation flow entries", () => {
  const at = new Date("2026-08-23T12:00:02.000Z");

  it("drops the approval echo, because the receipt states the outcome", () => {
    const blocks = blocksFrom(
      [
        {
          id: "e1",
          type: "log",
          message: "Approve this action? No",
          meta: { approvalEcho: true },
          timestamp: at,
        },
      ],
      "",
      EMPTY_REGIONS,
    );
    expect(blocks).toHaveLength(0);
  });

  it("drops the duration line of reasoning that returned no text", () => {
    const blocks = blocksFrom(
      [
        {
          id: "z1",
          type: "log",
          message: "Reasoning · 1.6s",
          meta: { collapsedRegion: "reasoning" },
          timestamp: at,
        },
        {
          id: "z2",
          type: "log",
          message: "scout completed · 4.0s",
          meta: { collapsedRegion: "subagent" },
          timestamp: at,
        },
      ],
      "",
      EMPTY_REGIONS,
    );
    expect(blocks).toEqual([expect.objectContaining({ text: "scout completed · 4.0s" })]);
  });

  it("carries a declined call as one denied receipt", () => {
    const blocks = blocksFrom(
      [
        {
          id: "r1",
          type: "log",
          message: "",
          meta: {
            toolReceipt: { app: "write_file", summary: "", status: "denied", args: "path: a.txt" },
          },
          timestamp: at,
        },
      ],
      "",
      EMPTY_REGIONS,
    );
    expect(blocks).toEqual([
      expect.objectContaining({ kind: "tool", app: "write_file", status: "denied" }),
    ]);
  });

  it("shows an answer that never streamed as agent prose, without a separate name line", () => {
    const blocks = blocksFrom(
      [
        { id: "h1", type: "info", message: "sol", meta: { agentHeader: true }, timestamp: at },
        {
          id: "a1",
          type: "log",
          message: "rendered",
          meta: { plainText: "rendered", agentMarkdown: "**Done.**" },
          timestamp: at,
        },
      ],
      "",
      EMPTY_REGIONS,
    );
    expect(blocks).toEqual([expect.objectContaining({ kind: "agent", markdown: "**Done.**" })]);
  });

  it("marks the turn receipt as its own quiet notice", () => {
    const blocks = blocksFrom(
      [
        {
          id: "t1",
          type: "debug",
          message: "9.7s · 2 steps",
          meta: { turnReceipt: true, plainText: "9.7s · 2 steps" },
          timestamp: at,
        },
      ],
      "",
      EMPTY_REGIONS,
    );
    expect(blocks).toEqual([
      expect.objectContaining({ kind: "notice", tone: "receipt", text: "9.7s · 2 steps" }),
    ]);
  });
});

describe("command reports", () => {
  it("travel as data, so the transcript sets them in jazz's voice rather than as styled text", () => {
    const answer = report("theme", [{ kind: "field", key: "current", value: "jazz, dark" }]);
    const entry: OutputEntry = {
      id: "r1",
      type: "log",
      message: "\u001b[1mtheme\u001b[22m current jazz, dark",
      timestamp: new Date("2026-08-23T12:00:02.000Z"),
      meta: { report: answer, plainText: "theme     current   jazz, dark" },
    };
    const [block] = blocksFrom([entry], "", EMPTY_REGIONS);
    expect(block?.kind).toBe("report");
    expect(block?.kind === "report" ? block.report : undefined).toBe(answer);
  });
});

describe("the waiting label", () => {
  it("says thinking once the model is reasoning", () => {
    expect(waitingLabel("thinking", 12_000)).toBe("thinking");
  });

  it("fills the silence before the first event with the house copy", () => {
    const first = waitingLabel("awaiting", 0);
    expect(first).not.toBe("thinking");
    expect(waitingLabel("awaiting", 4_000)).not.toBe(first);
  });
});
