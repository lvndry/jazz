import { beforeAll, describe, expect, it } from "bun:test";
import { getGlyphs } from "../glyphs";
import { setThemeVariant, THEME } from "../theme";
import { forgetStreamingRows, transcriptRows, type RenderRow } from "./Transcript";
import type { Block } from "./types";

const VIEWPORT = { width: 120, height: 40 };

const ANSWER = [
  "Here is what I found in the repository.",
  "",
  "## Packages",
  "",
  "- `core` holds the agent loop and a long description that wraps past the measure of the column",
  "  and keeps going on a lazy continuation line",
  "- `cli` holds the terminal interface",
  "",
  "| package | role |",
  "|---|---|",
  "| core | loop |",
  "| cli | terminal |",
  "",
  "```ts",
  "const answer = compute();",
  "",
  "console.log(answer);",
  "```",
  "",
  "> A quoted line that the model",
  "> continues on a second line.",
  "",
  "",
  "1. first",
  "2. second",
  "",
  "That's the overview.",
  "",
].join("\n");

function streamingBlock(markdown: string): Block[] {
  return [{ id: "answer", seq: 0, kind: "agent", markdown, streaming: true }];
}

/**
 * A streaming answer has an accent rail and a cursor after its last text, and a
 * settled one has neither; everything else must match.
 */
function withoutStreamingMarks(rows: readonly RenderRow[]): string {
  const cursor = getGlyphs().streamCursor;
  return JSON.stringify(
    rows.map((row, index) => ({
      ...row,
      gutter: row.gutter.map((cell) => cell.text),
      content:
        index === rows.length - 1 && row.content.at(-1)?.text === cursor
          ? row.content.slice(0, -1)
          : row.content,
    })),
  );
}

function freshRows(markdown: string): RenderRow[] {
  forgetStreamingRows();
  const rows = transcriptRows(streamingBlock(markdown), VIEWPORT);
  forgetStreamingRows();
  return rows;
}

describe("a streaming answer renders incrementally", () => {
  beforeAll(() => {
    setThemeVariant("dark");
  });

  it("renders every prefix exactly as a from-scratch render of the same text", () => {
    forgetStreamingRows();
    const streamed: string[] = [];
    for (let length = 1; length <= ANSWER.length; length += 1) {
      streamed.push(
        JSON.stringify(transcriptRows(streamingBlock(ANSWER.slice(0, length)), VIEWPORT)),
      );
    }
    const mismatches: number[] = [];
    for (let length = 1; length <= ANSWER.length; length += 1) {
      if (streamed[length - 1] !== JSON.stringify(freshRows(ANSWER.slice(0, length)))) {
        mismatches.push(length);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps the rows of settled paragraphs instead of rebuilding them each frame", () => {
    forgetStreamingRows();
    const settled = ANSWER.slice(0, ANSWER.indexOf("That's"));
    const before = transcriptRows(streamingBlock(`${settled}That`), VIEWPORT);
    const after = transcriptRows(streamingBlock(`${settled}That's the`), VIEWPORT);
    const firstRow = (rows: readonly RenderRow[]): RenderRow | undefined =>
      rows.find((row) => row.key.startsWith("answer:0"));
    expect(firstRow(after)).toBe(firstRow(before));
  });

  it("starts over when the text is not a continuation of what was on screen", () => {
    forgetStreamingRows();
    transcriptRows(streamingBlock(ANSWER), VIEWPORT);
    const replaced = "A different answer.\n\nWith two paragraphs.";
    expect(JSON.stringify(transcriptRows(streamingBlock(replaced), VIEWPORT))).toBe(
      JSON.stringify(freshRows(replaced)),
    );
  });

  it("renders every prefix of a mixed answer the way a settled answer renders it", () => {
    forgetStreamingRows();
    const mismatches: number[] = [];
    for (let length = 1; length <= ANSWER.length; length += 1) {
      const markdown = ANSWER.slice(0, length);
      const streamed = transcriptRows(streamingBlock(markdown), VIEWPORT);
      const settled = transcriptRows(
        [{ id: "answer", seq: 0, kind: "agent", markdown, streaming: false }],
        VIEWPORT,
      );
      if (withoutStreamingMarks(streamed) !== withoutStreamingMarks(settled))
        mismatches.push(length);
    }
    expect(mismatches).toEqual([]);
  });

  it("renders a long unclosed fence the way a settled answer renders it", () => {
    forgetStreamingRows();
    const fence = [
      "Here is the file:",
      "",
      "```ts",
      "/* a block comment that",
      "   spans two lines */",
      'const greeting = "hello";',
      "const aMuchLongerLineThatWidensTheBandPastTheProseMeasureOfTheColumnForSureAndThenSome = 1;",
      "export default greeting;",
    ].join("\n");
    const mismatches: number[] = [];
    for (let length = 1; length <= fence.length; length += 1) {
      const markdown = fence.slice(0, length);
      const streamed = transcriptRows(streamingBlock(markdown), VIEWPORT);
      const settled = transcriptRows(
        [{ id: "answer", seq: 0, kind: "agent", markdown, streaming: false }],
        VIEWPORT,
      );
      if (withoutStreamingMarks(streamed) !== withoutStreamingMarks(settled))
        mismatches.push(length);
    }
    expect(mismatches).toEqual([]);
  });

  it("does not re-highlight settled fence lines on later frames", () => {
    forgetStreamingRows();
    const opening = "```ts\n" + "const line = 1;\n".repeat(40);
    const before = transcriptRows(streamingBlock(`${opening}const`), VIEWPORT);
    const after = transcriptRows(streamingBlock(`${opening}const next`), VIEWPORT);
    const rowFor = (rows: readonly RenderRow[]): RenderRow | undefined =>
      rows.find((row) => row.key === "answer:0:3");
    expect(rowFor(after)).toBeDefined();
    expect(rowFor(after)).toBe(rowFor(before));
  });

  it("settles into the same rows the streamed frames converged on", () => {
    forgetStreamingRows();
    const streamed = transcriptRows(streamingBlock(ANSWER), VIEWPORT);
    const reference = freshRows(ANSWER);
    expect(JSON.stringify(streamed)).toBe(JSON.stringify(reference));
  });
});

describe("the stream cursor", () => {
  beforeAll(() => {
    setThemeVariant("dark");
  });

  it("sits in the accent after the last text while the answer streams", () => {
    const rows = transcriptRows(streamingBlock("Three things need you"), VIEWPORT);
    const last = rows.at(-1)?.content.at(-1);
    expect(last).toEqual({ text: getGlyphs().streamCursor, fg: THEME.agent });
  });

  it("is gone once the answer settles", () => {
    const rows = transcriptRows(
      [
        {
          id: "answer",
          seq: 0,
          kind: "agent",
          markdown: "Three things need you",
          streaming: false,
        },
      ],
      VIEWPORT,
    );
    expect(rows.flatMap((row) => row.content).map((segment) => segment.text)).not.toContain(
      getGlyphs().streamCursor,
    );
  });

  it("never pushes a full line past its width", () => {
    const full = "word ".repeat(200).trim();
    const rows = transcriptRows(streamingBlock(full), VIEWPORT);
    for (const row of rows) {
      const width = row.content.reduce((total, segment) => total + [...segment.text].length, 0);
      expect(width).toBeLessThanOrEqual(row.contentWidth);
    }
  });
});
