/** @jsxImportSource @opentui/react */

/**
 * The prompt overlays are asserted on the composited frame rather than on a
 * React tree, for the same reason the approval overlay is: the claims are
 * claims about characters and attributes. Whether a password leaked, whether
 * the selected row is marked by weight or by a wash, whether the caret is a
 * cell or a glyph — none of those are visible in a component tree.
 *
 * `captureSpans()` carries the real per-span foreground and background, which
 * the rest of the suite cannot see, so the colour law is enforced here.
 */

import { TextAttributes, type CapturedFrame, type CapturedSpan } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { getGlyphs } from "../../glyphs";
import { THEME } from "../../theme";
import type { Viewport } from "../types";
import { FilePicker, type FilePickerModel } from "./FilePicker";
import { Question, type QuestionModel } from "./Question";
import { TextPrompt, type TextPromptModel } from "./TextPrompt";

const WIDE: Viewport = { width: 120, height: 34 };
const MEDIUM: Viewport = { width: 80, height: 24 };
const SMALL: Viewport = { width: 60, height: 20 };
const NARROW: Viewport = { width: 70, height: 18 };

/**
 * U+2550–U+2570: the double-line box drawing family and the four rounded
 * corners. Terminals do not draw these procedurally and they are the most
 * fallback-prone glyphs in the range, so no frame may contain one.
 */
const FORBIDDEN_BOX = /[═-╰]/;

/**
 * Verified ranges: ASCII, Latin-1, General Punctuation, Mathematical
 * Operators, Box Drawing and Block Elements. Everything else risks a fallback
 * glyph at a mismatched advance width, which mis-aligns every column after it.
 */
function safeCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    (codePoint >= 0x2000 && codePoint <= 0x206f) ||
    (codePoint >= 0x2200 && codePoint <= 0x22ff) ||
    (codePoint >= 0x2500 && codePoint <= 0x259f)
  );
}

const QUESTION: QuestionModel = {
  kind: "question",
  mode: "select",
  message: "Which calendar should the flight go on?",
  choices: [
    { label: "Work", value: "work", description: "the one with the meetings" },
    { label: "Personal", value: "personal", description: "evenings and weekends" },
    { label: "Family", value: "family", description: "shared with Ana" },
  ],
  selected: 1,
};

const CONFIRM: QuestionModel = {
  kind: "question",
  mode: "select",
  message: "Book the 09:40 to Basel?",
  choices: [
    { label: "Yes, book it", value: "yes" },
    { label: "No, leave it", value: "no" },
  ],
  selected: 0,
};

const CHECKBOX: QuestionModel = {
  kind: "question",
  mode: "checkbox",
  message: "Which of these should I include?",
  choices: [
    { label: "Flights", value: "flights" },
    { label: "Hotels", value: "hotels" },
    { label: "Restaurants", value: "restaurants" },
  ],
  selected: 2,
  checked: ["flights", "restaurants"],
};

const TEXT: TextPromptModel = {
  kind: "text",
  message: "What should I call this agent?",
  value: "trip planner",
  caret: 12,
};

/**
 * Every character here is absent from the message, the hints and the frame,
 * so a single occurrence is a leak.
 */
const SECRET = "Z7QXV9KJ2";

const PASSWORD: TextPromptModel = {
  kind: "text",
  message: "Paste your api key",
  value: SECRET,
  caret: SECRET.length,
  masked: true,
};

const FILES: FilePickerModel = {
  kind: "filepicker",
  message: "Which file should I attach?",
  basePath: "/Users/landry/github/jazz",
  entries: [
    { name: "src/services", isDirectory: true },
    { name: "src/cli/ui/theme.ts", isDirectory: false },
    { name: "src/cli/ui/glyphs.ts", isDirectory: false },
  ],
  selected: 1,
  filter: "src",
};

function rows(frame: string): string[] {
  return frame.split("\n").filter((row) => row.length > 0);
}

function allSpans(frame: CapturedFrame): CapturedSpan[] {
  return frame.lines.flatMap((line) => line.spans);
}

function toHex(channels: readonly number[]): string {
  return channels
    .slice(0, 3)
    .reduce((hex, channel) => hex + channel.toString(16).padStart(2, "0"), "#")
    .toUpperCase();
}

function hexOf(span: CapturedSpan): string {
  return toHex(span.fg.toInts());
}

function bgOf(span: CapturedSpan): string {
  return toHex(span.bg.toInts());
}

function themeHex(color: string): string {
  return color.toUpperCase();
}

function spanWithText(frame: CapturedFrame, text: string): CapturedSpan {
  const found = allSpans(frame).find((span) => span.text === text);
  if (found === undefined) {
    throw new Error(`no span with exact text ${JSON.stringify(text)}`);
  }
  return found;
}

function inverseSpans(frame: CapturedFrame): CapturedSpan[] {
  return allSpans(frame).filter((span) => (span.attributes & TextAttributes.INVERSE) !== 0);
}

/** Indices of the rows a bordered frame occupies. */
function framedRows(frame: string): number[] {
  const glyphs = getGlyphs();
  return rows(frame)
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.includes(glyphs.boxV) || row.includes(glyphs.boxTL))
    .map(({ index }) => index);
}

async function draw(node: ReactNode, viewport: Viewport) {
  const setup = await testRender(node, { width: viewport.width, height: viewport.height });
  await setup.renderOnce();
  return setup;
}

/** Every row is exactly the viewport width, and there are exactly as many as it is tall. */
async function expectRectangular(node: ReactNode, viewport: Viewport): Promise<void> {
  const { renderer, captureCharFrame } = await draw(node, viewport);
  const lines = rows(captureCharFrame());
  expect(lines).toHaveLength(viewport.height);
  for (const line of lines) expect([...line]).toHaveLength(viewport.width);
  renderer.destroy();
}

/** Fullscreen: the frame owns column zero of row zero, and the keys are the last row. */
async function expectFullscreen(
  node: ReactNode,
  viewport: Viewport,
  lastRowContains: string,
): Promise<void> {
  const { renderer, captureCharFrame } = await draw(node, viewport);
  const lines = rows(captureCharFrame());
  expect(lines).toHaveLength(viewport.height);
  for (const line of lines) expect([...line]).toHaveLength(viewport.width);
  expect((lines[0] ?? "")[0]).toBe(getGlyphs().boxTL);
  expect(lines[viewport.height - 1]).toContain(lastRowContains);
  renderer.destroy();
}

describe("question overlay", () => {
  it("shows the question, every choice, every description and the keys", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={QUESTION}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain(QUESTION.message);
    for (const choice of QUESTION.choices) {
      expect(frame).toContain(choice.label);
      expect(frame).toContain(choice.description ?? "");
    }
    expect(frame).toContain("move");
    expect(frame).toContain("select");
    expect(frame).toContain("cancel");
    expect(frame).toContain("2 of 3");

    renderer.destroy();
  });

  it("handles a two-choice question without special-casing it", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={CONFIRM}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain("Yes, book it");
    expect(frame).toContain("No, leave it");
    expect(frame).toContain("1 of 2");

    renderer.destroy();
  });

  it("marks the selected row by weight and a rail, never by a background", async () => {
    const { renderer, captureSpans } = await draw(
      <Question
        model={QUESTION}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureSpans();

    const chosen = spanWithText(frame, "Personal");
    const other = spanWithText(frame, "Work");
    expect(chosen.attributes & TextAttributes.BOLD).not.toBe(0);
    expect(other.attributes & TextAttributes.BOLD).toBe(0);

    // The rail, in the accent, exactly once.
    const rails = allSpans(frame).filter(
      (span) => span.text.trim() === getGlyphs().rail && hexOf(span) === themeHex(THEME.primary),
    );
    expect(rails).toHaveLength(1);

    // Same ground under the selected row as under its neighbours, and nothing
    // is inverted: a wash would show up as either.
    expect(bgOf(chosen)).toBe(bgOf(other));
    expect(inverseSpans(frame)).toHaveLength(0);

    renderer.destroy();
  });

  it("spends its colours on the roles the palette assigns them", async () => {
    const { renderer, captureSpans } = await draw(
      <Question
        model={QUESTION}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureSpans();

    // The chosen answer is the brightest thing in the list; the others sit a
    // step down the neutral ramp, and the reasons a step below that.
    expect(hexOf(spanWithText(frame, "Personal"))).toBe(themeHex(THEME.selected));
    expect(hexOf(spanWithText(frame, "Work"))).toBe(themeHex(THEME.secondary));
    expect(hexOf(spanWithText(frame, "  evenings and weekends"))).toBe(themeHex(THEME.muted));

    // The accent appears only on the rail: nothing else in a question is live.
    const accented = allSpans(frame).filter(
      (span) => span.text.trim().length > 0 && hexOf(span) === themeHex(THEME.primary),
    );
    expect(accented).toHaveLength(1);
    expect(accented[0]?.text.trim()).toBe(getGlyphs().rail);

    renderer.destroy();
  });

  it("keeps the selection on screen in a list far longer than the frame", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      label: `Option ${String(index + 1).padStart(2, "0")}`,
      value: `option-${String(index)}`,
    }));
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={{ ...QUESTION, choices: many, selected: 33 }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain("Option 34");
    expect(frame).not.toContain("Option 01");
    expect(frame).not.toContain("Option 20");
    expect(frame).toContain("34 of 40");
    expect(rows(frame)).toHaveLength(WIDE.height);

    renderer.destroy();
  });

  it("shows only the first ten choices until the window moves", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      label: `Option ${String(index + 1).padStart(2, "0")}`,
      value: `option-${String(index)}`,
    }));
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={{ ...QUESTION, choices: many, selected: 0 }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain("Option 01");
    expect(frame).toContain("Option 10");
    expect(frame).not.toContain("Option 11");
    expect(frame).toContain("1 of 40");

    renderer.destroy();
  });

  it("numbers every visible row including the tenth", async () => {
    const labels = [
      "Anthropic",
      "OpenAI",
      "Google",
      "Mistral",
      "Groq",
      "xAI",
      "Cohere",
      "Together",
      "DeepSeek",
      "Fireworks",
      "Cerebras",
    ];
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={{
          ...QUESTION,
          message: "Which LLM provider would you like to use?",
          choices: labels.map((label) => ({ label, value: label.toLowerCase() })),
          selected: 0,
        }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(captureCharFrame());
    const tenth = lines.find((line) => line.includes("Fireworks")) ?? "";
    const first = lines.find((line) => line.includes("Anthropic")) ?? "";

    expect(tenth).toMatch(/10\s+Fireworks/);
    expect(first).toMatch(/1\s+Anthropic/);
    expect(tenth.indexOf("Fireworks")).toBe(first.indexOf("Anthropic"));
    expect(lines.some((line) => line.includes("Cerebras"))).toBe(false);

    renderer.destroy();
  });

  it("filters a long list and reports when nothing matches", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      label: `Option ${String(index + 1).padStart(2, "0")}`,
      value: `option-${String(index)}`,
    }));
    const filtered = await draw(
      <Question
        model={{
          ...QUESTION,
          choices: [many[11] ?? many[0]!],
          selected: 0,
          filterable: true,
          filter: "12",
        }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const filteredFrame = filtered.captureCharFrame();
    expect(filteredFrame).toContain("Option 12");
    expect(filteredFrame).not.toContain("Option 01");
    expect(filteredFrame).toContain("12");
    expect(filteredFrame).toContain("filter");
    filtered.renderer.destroy();

    const empty = await draw(
      <Question
        model={{
          ...QUESTION,
          choices: [],
          selected: 0,
          filterable: true,
          filter: "zzzz",
        }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const emptyFrame = empty.captureCharFrame();
    expect(emptyFrame).toContain("No matching options");
    expect(emptyFrame).toContain("zzzz");
    empty.renderer.destroy();
  });

  it("wraps a long description instead of cropping it", async () => {
    const tail = "ENDOFDESCRIPTION";
    const description = `${"a reason this option exists ".repeat(12)}${tail}`;
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={{
          ...QUESTION,
          choices: [
            { label: "Work", value: "work", description },
            { label: "Personal", value: "personal" },
          ],
          selected: 0,
        }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(captureCharFrame());
    const frame = lines.join("\n");

    expect(frame).toContain(tail);
    expect(frame).not.toContain("…");
    const carrying = lines.filter((line) => line.includes("a reason this option exists"));
    expect(carrying.length).toBeGreaterThan(1);

    renderer.destroy();
  });

  it("sits on the bottom so the conversation stays visible above it", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={QUESTION}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(captureCharFrame());
    const glyphs = getGlyphs();

    expect(lines[0]?.includes(glyphs.boxTL) ?? true).toBe(false);
    expect(lines.some((line) => line.includes(glyphs.boxTL))).toBe(true);
    expect(lines.at(-1)).toContain("move");

    renderer.destroy();
  });

  it("shows checkbox state as a mark, independent of what is focused", async () => {
    const glyphs = getGlyphs();
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={CHECKBOX}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(captureCharFrame());
    const rowFor = (label: string): string => lines.find((line) => line.includes(label)) ?? "";

    expect(rowFor("Flights")).toContain(`[${glyphs.success}]`);
    expect(rowFor("Restaurants")).toContain(`[${glyphs.success}]`);
    expect(rowFor("Hotels")).toContain("[ ]");
    // Focused but unchecked, and checked but unfocused, both exist at once. The
    // rail lives in the gutter between the frame edge and the label — asserted
    // by containment rather than column, since the option block is centered and
    // its offset depends on row widths.
    const gutterSegmentOf = (label: string): string => {
      const line = rowFor(label);
      const borderIndex = line.indexOf(glyphs.boxV);
      return line.slice(borderIndex + 1, line.indexOf(label));
    };
    expect(gutterSegmentOf("Restaurants")).toContain(glyphs.rail);
    expect(gutterSegmentOf("Flights")).not.toContain(glyphs.rail);

    expect(lines.join("\n")).toContain("2 selected");
    expect(lines.join("\n")).toContain("toggle");

    renderer.destroy();
  });

  it("offers a row to type your own answer, and types into it when it is focused", async () => {
    const resting = await draw(
      <Question
        model={{ ...QUESTION, allowCustom: true, selected: 0 }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const restingFrame = resting.captureCharFrame();
    expect(restingFrame).toContain("Type your own answer");
    expect(rows(restingFrame)).toHaveLength(WIDE.height);
    resting.renderer.destroy();

    const typing = await draw(
      <Question
        model={{
          ...QUESTION,
          allowCustom: true,
          selected: QUESTION.choices.length,
          customValue: "the one in Basel",
          customCaret: 16,
        }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const spans = typing.captureSpans();
    expect(typing.captureCharFrame()).toContain("the one in Basel");
    // The caret is the only inverted cell on the frame.
    expect(inverseSpans(spans)).toHaveLength(1);
    typing.renderer.destroy();
  });

  it("still offers the custom row when there is nothing to choose from", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={{ ...QUESTION, choices: [] }}
        viewport={WIDE}
      />,
      WIDE,
    );
    expect(captureCharFrame()).toContain("Type your own answer");
    renderer.destroy();
  });

  it("sheds the keys it can afford to lose rather than clipping escape off the row", async () => {
    const { renderer, captureCharFrame } = await draw(
      <Question
        model={CHECKBOX}
        viewport={SMALL}
      />,
      SMALL,
    );
    const keys = rows(captureCharFrame()).at(-1) ?? "";

    // The row is too narrow for the whole legend, so the arrow cluster goes —
    // and the one key that gets a user out of a modal stays.
    expect(keys).toContain("esc cancel");
    expect(keys).toContain("enter submit");
    expect(keys).toContain("space toggle");
    expect(keys).not.toContain("up/down");
    expect([...keys]).toHaveLength(SMALL.width);

    renderer.destroy();
  });

  it("holds a rectangular frame at every supported width", async () => {
    for (const viewport of [WIDE, MEDIUM, SMALL]) {
      await expectRectangular(
        <Question
          model={QUESTION}
          viewport={viewport}
        />,
        viewport,
      );
    }
  });

  it("goes fullscreen rather than drawing a cramped card", async () => {
    await expectFullscreen(
      <Question
        model={QUESTION}
        viewport={NARROW}
      />,
      NARROW,
      "move",
    );
  });
});

describe("text prompt overlay", () => {
  it("shows the message, the value and the keys", async () => {
    const { renderer, captureCharFrame } = await draw(
      <TextPrompt
        model={TEXT}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain(TEXT.message);
    expect(frame).toContain("trip planner");
    expect(frame).toContain("submit");
    expect(frame).toContain("to go back");

    renderer.destroy();
  });

  it("shows the caret as a single inverted cell rather than a glyph", async () => {
    const { renderer, captureSpans } = await draw(
      <TextPrompt
        model={{ ...TEXT, caret: 2 }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const inverted = inverseSpans(captureSpans());

    expect(inverted).toHaveLength(1);
    expect([...(inverted[0]?.text ?? "")]).toHaveLength(1);
    // It sits *on* a character of the value, not beside it.
    expect(inverted[0]?.text).toBe("i");

    renderer.destroy();
  });

  it("masks the prefix of a secret and reveals only the last 6 characters", async () => {
    const longSecret = "c9706a74-71d7-4523-8044-29b01abff127";
    const { renderer, captureCharFrame } = await draw(
      <TextPrompt
        model={{ ...PASSWORD, value: longSecret, caret: longSecret.length }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain("***bff127");
    expect(frame).not.toContain(longSecret);
    expect(frame).not.toContain("c9706a74");
    expect(frame).toContain("hidden while you type");

    renderer.destroy();
  });

  it("states a validation failure in the error hue without resizing the card", async () => {
    const clean = await draw(
      <TextPrompt
        model={TEXT}
        viewport={WIDE}
      />,
      WIDE,
    );
    const before = framedRows(clean.captureCharFrame());
    clean.renderer.destroy();

    const failed = await draw(
      <TextPrompt
        model={{ ...TEXT, error: "That name is already taken." }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const spans = failed.captureSpans();
    const charFrame = failed.captureCharFrame();

    expect(charFrame).toContain("That name is already taken.");
    expect(framedRows(charFrame)).toEqual(before);
    expect(hexOf(spanWithText(spans, `${getGlyphs().error} That name is already taken.`))).toBe(
      themeHex(THEME.error),
    );

    failed.renderer.destroy();
  });

  it("scrolls a value longer than the row so the caret stays visible", async () => {
    const value = `${"x".repeat(400)}TAIL`;
    const { renderer, captureSpans, captureCharFrame } = await draw(
      <TextPrompt
        model={{ ...TEXT, value, caret: value.length }}
        viewport={WIDE}
      />,
      WIDE,
    );

    expect(captureCharFrame()).toContain("TAIL");
    expect(inverseSpans(captureSpans())).toHaveLength(1);
    for (const line of rows(captureCharFrame())) {
      expect([...line]).toHaveLength(WIDE.width);
    }

    renderer.destroy();
  });

  it("holds a rectangular frame at every supported width", async () => {
    for (const viewport of [WIDE, MEDIUM, SMALL]) {
      await expectRectangular(
        <TextPrompt
          model={TEXT}
          viewport={viewport}
        />,
        viewport,
      );
    }
  });

  it("goes fullscreen rather than drawing a cramped card", async () => {
    await expectFullscreen(
      <TextPrompt
        model={TEXT}
        viewport={NARROW}
      />,
      NARROW,
      "submit",
    );
  });
});

describe("file picker overlay", () => {
  it("shows the message, the base, the filter, the entries and the keys", async () => {
    const { renderer, captureCharFrame } = await draw(
      <FilePicker
        model={FILES}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain(FILES.message);
    expect(frame).toContain(FILES.basePath);
    expect(frame).toContain("src/services/");
    expect(frame).toContain("theme.ts");
    expect(frame).toContain("3 entries");
    expect(frame).toContain("2 of 3");
    expect(frame).toContain("choose");
    expect(frame).toContain("cancel");

    renderer.destroy();
  });

  it("tells a directory from a file twice over, and never with an emoji", async () => {
    const glyphs = getGlyphs();
    const { renderer, captureCharFrame } = await draw(
      <FilePicker
        model={FILES}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(captureCharFrame());
    const directory = lines.find((line) => line.includes("src/services")) ?? "";
    const file = lines.find((line) => line.includes("theme.ts")) ?? "";

    // The path separator on the end, and the marker in the gutter.
    expect(directory).toContain("src/services/");
    expect(file).not.toContain("theme.ts/");
    expect(directory).toContain(glyphs.arrow);
    expect(file).not.toContain(glyphs.arrow);

    for (const character of lines.join("")) {
      expect(safeCodePoint(character.codePointAt(0) ?? 0)).toBe(true);
    }

    renderer.destroy();
  });

  it("truncates a long path from the left, keeping the informative tail", async () => {
    const deep = `${"a-long-directory-name/".repeat(8)}invoice.pdf`;
    const { renderer, captureCharFrame } = await draw(
      <FilePicker
        model={{
          ...FILES,
          basePath: `/Users/landry/${"nested/".repeat(12)}root`,
          entries: [{ name: deep, isDirectory: false }],
          selected: 0,
        }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const lines = rows(captureCharFrame());
    const entry = lines.find((line) => line.includes("invoice.pdf")) ?? "";
    const base = lines.find((line) => line.includes("base ")) ?? "";

    // The head is elided and the filename — the part being chosen — survives.
    expect(entry).toContain("…");
    expect(entry).toContain("invoice.pdf");
    expect(entry.split("a-long-directory-name").length - 1).toBeLessThan(8);
    // The tail of the base path survives; its head is the part the reader knows.
    expect(base).toContain("root");
    expect(base).toContain("…");

    renderer.destroy();
  });

  it("keeps the selection on screen in a list far longer than the frame", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: `file-${String(index + 1).padStart(2, "0")}.ts`,
      isDirectory: false,
    }));
    const { renderer, captureCharFrame } = await draw(
      <FilePicker
        model={{ ...FILES, entries: many, selected: 51 }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const frame = captureCharFrame();

    expect(frame).toContain("file-52.ts");
    expect(frame).not.toContain("file-01.ts");
    expect(frame).toContain("52 of 60");

    renderer.destroy();
  });

  it("keeps the frame exactly as tall whether the filter matches everything or nothing", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: `file-${String(index)}.ts`,
      isDirectory: false,
    }));
    const full = await draw(
      <FilePicker
        model={{ ...FILES, entries: many, selected: 0 }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const before = framedRows(full.captureCharFrame());
    full.renderer.destroy();

    const empty = await draw(
      <FilePicker
        model={{ ...FILES, entries: [], selected: 0, filter: "nothing-like-this" }}
        viewport={WIDE}
      />,
      WIDE,
    );
    const emptyFrame = empty.captureCharFrame();

    expect(emptyFrame).toContain("nothing here");
    expect(emptyFrame).toContain("Nothing under this base matches");
    expect(framedRows(emptyFrame)).toEqual(before);

    empty.renderer.destroy();
  });

  it("keeps escape on the keys row even where the whole legend will not fit", async () => {
    const { renderer, captureCharFrame } = await draw(
      <FilePicker
        model={FILES}
        viewport={SMALL}
      />,
      SMALL,
    );
    const keys = rows(captureCharFrame()).at(-1) ?? "";

    expect(keys).toContain("esc cancel");
    expect(keys).toContain("enter choose");
    expect(keys).not.toContain("tab");

    renderer.destroy();
  });

  it("holds a rectangular frame at every supported width", async () => {
    for (const viewport of [WIDE, MEDIUM, SMALL]) {
      await expectRectangular(
        <FilePicker
          model={FILES}
          viewport={viewport}
        />,
        viewport,
      );
    }
  });

  it("goes fullscreen rather than drawing a cramped card", async () => {
    await expectFullscreen(
      <FilePicker
        model={FILES}
        viewport={NARROW}
      />,
      NARROW,
      "choose",
    );
  });
});

describe("prompt overlays in unicode glyph mode", () => {
  const previous = process.env["JAZZ_UI_GLYPHS"];

  beforeAll(() => {
    process.env["JAZZ_UI_GLYPHS"] = "unicode";
  });

  afterAll(() => {
    if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
    else process.env["JAZZ_UI_GLYPHS"] = previous;
  });

  it("frames every prompt in light box drawing, never rounded or double", async () => {
    const glyphs = getGlyphs();
    const overlays: readonly ReactNode[] = [
      <Question
        key="question"
        model={QUESTION}
        viewport={WIDE}
      />,
      <Question
        key="checkbox"
        model={CHECKBOX}
        viewport={WIDE}
      />,
      <TextPrompt
        key="text"
        model={TEXT}
        viewport={WIDE}
      />,
      <TextPrompt
        key="password"
        model={PASSWORD}
        viewport={WIDE}
      />,
      <FilePicker
        key="files"
        model={FILES}
        viewport={WIDE}
      />,
    ];

    for (const overlay of overlays) {
      const { renderer, captureCharFrame } = await draw(overlay, WIDE);
      const frame = captureCharFrame();
      expect(frame).toContain(glyphs.boxTL);
      expect(frame).toContain(glyphs.boxBR);
      expect(FORBIDDEN_BOX.test(frame)).toBe(false);
      renderer.destroy();
    }
  });

  it("draws nothing from a font range the target fonts do not cover", async () => {
    const cases: readonly (readonly [ReactNode, Viewport])[] = [
      [
        <Question
          key="question"
          model={{ ...QUESTION, allowCustom: true, selected: 3, customValue: "somewhere else" }}
          viewport={WIDE}
        />,
        WIDE,
      ],
      [
        <Question
          key="checkbox"
          model={CHECKBOX}
          viewport={NARROW}
        />,
        NARROW,
      ],
      [
        <TextPrompt
          key="text"
          model={{ ...TEXT, error: "Pick another name." }}
          viewport={WIDE}
        />,
        WIDE,
      ],
      [
        <TextPrompt
          key="password"
          model={PASSWORD}
          viewport={NARROW}
        />,
        NARROW,
      ],
      [
        <FilePicker
          key="files"
          model={FILES}
          viewport={WIDE}
        />,
        WIDE,
      ],
      [
        <FilePicker
          key="files-narrow"
          model={{ ...FILES, entries: [], filter: "no" }}
          viewport={NARROW}
        />,
        NARROW,
      ],
    ];

    for (const [overlay, viewport] of cases) {
      const { renderer, captureCharFrame } = await draw(overlay, viewport);
      const offenders = [...new Set([...captureCharFrame()])]
        .filter((character) => character !== "\n")
        .filter((character) => !safeCodePoint(character.codePointAt(0) ?? 0))
        .map(
          (character) =>
            `${character} (U+${(character.codePointAt(0) ?? 0)
              .toString(16)
              .toUpperCase()
              .padStart(4, "0")})`,
        );
      expect(offenders).toEqual([]);
      renderer.destroy();
    }
  });
});
