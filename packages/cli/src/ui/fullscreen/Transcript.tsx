/** @jsxImportSource @opentui/react */

/**
 * The transcript: the one region that is actually *read* rather than glanced at.
 *
 * Two decisions carry the whole design.
 *
 * The first is the measure. `measureFor` gives running prose the content
 * column (viewport minus rail and right margin) and keeps a short flush-right
 * strip for timestamps, so a sentence and its metadata never collide and the
 * eye always returns to the same left edge. Tool output, tables and code
 * fences take the full content width — those are scanned, not read, and a
 * table squeezed to the prose measure is worse than a table that reaches the
 * frame.
 *
 * The second is density. The first draft of this layout measured 32% ink and
 * read as "very busy"; the target is ≤22% ink with ≥40% breathing rows. That is
 * not a preference, it is the contract `transcript.test.tsx` enforces. Three
 * rules get there: a blank row opens every turn, a settled tool call collapses
 * to a dim receipt with no marker and no duration (and several receipts share a
 * row), and markers appear only at turn boundaries and state changes.
 *
 * Geometry, at every width:
 *
 *   col 0        rail, or the turn marker on a block's first row
 *   col 1        lane tag — a delegated lane gets a column, never an indent
 *   col 2..      content, `prose` wide for reading or `content` wide for scanning
 *   flush right  metadata, ending two columns short of the page (see `pageWidth`)
 *
 * Rows are pre-wrapped here rather than left to the renderer, because the rail
 * has to appear on every row of a block and the wrap point is what guarantees
 * the measure. `transcriptRows` is therefore a pure function of the blocks and
 * the viewport, and is what the tests assert against.
 */

import { isFileMutationTool } from "@jazz/core/utils/tool-formatter";
import { TextAttributes } from "@opentui/core";
import {
  forwardRef,
  memo,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  highlightCodeLine,
  highlightFenceLines,
  pathFromFileArgsPreview,
  sourceLanguageFromPath,
} from "./syntax-spans";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { getThemeVariant, THEME } from "../theme";
import {
  fitTerminalSegments,
  sliceTerminalCells,
  terminalCellWidth,
  terminalGraphemes,
  terminalSegmentsWidth,
} from "./terminal-cells";
import { applyScrollDelta, clampScrollFromBottom, windowTranscriptRows } from "./transcript-window";
import { measureFor, type Block, type Focus, type ToolReceiptBlock, type Viewport } from "./types";
import { spaceReasoningSections } from "../../presentation/format-utils";

/** The rail lives in the left page margin, so the content column never moves. */
const GUTTER = 2;

/** Metadata stops here, so nothing ever touches the page's right edge. */
const RIGHT_MARGIN = 2;

/** Reasoning is subordinate by geometry: indented, and set to a narrower measure. */
const REASONING_INDENT = 2;
const REASONING_MEASURE_RATIO = 0.72;

/** Below this a receipt is not worth packing onto a shared row. */
const RECEIPT_GAP = 2;

// ─── Segments ────────────────────────────────────────────────────────────────

export interface Segment {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

interface InlineMarks {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

function sameInlineStyle(previous: Segment, current: Segment): boolean {
  return (
    previous.fg === current.fg &&
    previous.bold === current.bold &&
    previous.italic === current.italic &&
    previous.underline === current.underline &&
    previous.strikethrough === current.strikethrough
  );
}

function segmentAttributes(segment: Segment): number {
  let attributes = 0;
  if (segment.bold === true) attributes |= TextAttributes.BOLD;
  if (segment.italic === true) attributes |= TextAttributes.ITALIC;
  if (segment.underline === true) attributes |= TextAttributes.UNDERLINE;
  if (segment.strikethrough === true) attributes |= TextAttributes.STRIKETHROUGH;
  return attributes;
}

/**
 * One physical row. Everything above this type is markdown and view-model
 * logic; everything below it is layout. The split is what makes the design
 * assertable without a terminal.
 */
export interface RenderRow {
  readonly key: string;
  /** Two cells: rail or marker, then the lane tag. */
  readonly gutter: readonly Segment[];
  readonly content: readonly Segment[];
  /** `prose` for running text, the full content width for scanned output. */
  readonly contentWidth: number;
  readonly meta: readonly Segment[];
}

/**
 * Greedy word wrap that survives inline styling: the line breaks between words,
 * not between spans, so a bold run spanning a wrap point stays bold on both
 * rows.
 */
function wrap(segments: readonly Segment[], measure: number): Segment[][] {
  const width = Math.max(1, measure);
  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let used = 0;

  const push = (segment: Segment): void => {
    const last = line[line.length - 1];
    if (last !== undefined && sameInlineStyle(last, segment)) {
      line[line.length - 1] = { ...last, text: last.text + segment.text };
      return;
    }
    line.push(segment);
  };

  const breakLine = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const segment of segments) {
    // A newline is a hard break, not whitespace to flow through.
    //
    // Splitting on /(\s+)/ alone put the newline characters *into* a row as an
    // ordinary space run, so a multi-line string became one row containing a
    // literal newline — which truncates where it sits. Expanded reasoning
    // showed only its first line, and a diff arrived as one running paragraph
    // with every +/- marker stranded mid-sentence.
    //
    // Pushing the line even when it is empty is deliberate: two newlines in a
    // row are a paragraph break, and the blank row is the break.
    const hardLines = segment.text.split("\n");
    for (const [index, hardLine] of hardLines.entries()) {
      if (index > 0) breakLine();
      // Keep the separators: a wrapped line must not lose the spaces inside it.
      for (const word of hardLine.split(/(\s+)/)) {
        if (word.length === 0) continue;
        const size = terminalCellWidth(word);
        if (/^\s+$/.test(word)) {
          if (used > 0 && used + size <= width) {
            push({ ...segment, text: word });
            used += size;
          }
          continue;
        }
        if (used > 0 && used + size > width) {
          lines.push(line);
          line = [];
          used = 0;
        }
        // A single word longer than the measure is broken rather than allowed to
        // push past the right edge — a URL must not break the column.
        let rest = word;
        while (terminalCellWidth(rest) > width) {
          let head = sliceTerminalCells(rest, width - used);
          if (head.length === 0 && used > 0) {
            lines.push(line);
            line = [];
            used = 0;
            continue;
          }
          if (head.length === 0) head = terminalGraphemes(rest)[0] ?? "";
          push({ ...segment, text: head });
          lines.push(line);
          line = [];
          used = 0;
          rest = rest.slice(head.length);
        }
        push({ ...segment, text: rest });
        used += terminalCellWidth(rest);
      }
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [[]];
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${String(minutes)}m ${String(seconds)}s`;
}

// ─── Markdown ────────────────────────────────────────────────────────────────

/**
 * OpenTUI ships a `<markdown>` renderable, and it is not usable here. It draws
 * nothing at all for a paragraph unless either a tree-sitter client is attached
 * or `streaming` is left permanently true, it hardcodes its own list bullets and
 * blockquote bars where this product is required to route every glyph through
 * `getGlyphs()` so the ASCII fallback works, and it renders one subtree at one
 * measure — which forfeits exactly the prose/table measure split above. So the
 * inline grammar agent prose actually uses is tokenised here into styled spans.
 */
type ProseItem =
  | { readonly kind: "text"; readonly segments: readonly Segment[]; readonly indent: number }
  | { readonly kind: "blank" }
  | { readonly kind: "rule" }
  | { readonly kind: "fence"; readonly language: string; readonly lines: readonly string[] }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] };

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9]/.test(character);
}

function delimiterRunLength(text: string, index: number, marker: "*" | "_"): number {
  let length = 0;
  while (text[index + length] === marker) length += 1;
  return length;
}

function skipCodeSpan(text: string, index: number): number {
  if (text[index] !== "`") return index;
  const close = text.indexOf("`", index + 1);
  return close === -1 ? index + 1 : close + 1;
}

function findDelimiterClose(text: string, from: number, marker: string): number {
  let index = from;
  const runCharacter = marker[0];
  while (index < text.length) {
    index = skipCodeSpan(text, index);
    if (index >= text.length) break;
    if (text.startsWith(marker, index) && (runCharacter === "*" || runCharacter === "_")) {
      const run = delimiterRunLength(text, index, runCharacter);
      if (run === marker.length) return index;
      index += run;
      continue;
    }
    if (text.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}

function canOpenUnderscoreItalic(text: string, index: number): boolean {
  return !isWordCharacter(text[index - 1]);
}

function canCloseUnderscoreItalic(text: string, closeIndex: number): boolean {
  return !isWordCharacter(text[closeIndex + 1]);
}

function findUnderscoreItalicClose(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    index = skipCodeSpan(text, index);
    if (index >= text.length) break;
    if (text[index] === "_") {
      const run = delimiterRunLength(text, index, "_");
      if (run === 1 && canCloseUnderscoreItalic(text, index)) return index;
      index += run;
      continue;
    }
    index += 1;
  }
  return -1;
}

function matchLink(
  text: string,
  index: number,
): { readonly label: string; readonly end: number } | undefined {
  if (text[index] !== "[") return undefined;
  const close = text.indexOf("]", index + 1);
  if (close === -1 || text[close + 1] !== "(") return undefined;
  const urlEnd = text.indexOf(")", close + 2);
  if (urlEnd === -1) return undefined;
  return { label: text.slice(index + 1, close), end: urlEnd + 1 };
}

function matchWrapped(
  text: string,
  index: number,
  open: string,
  close: string,
): { readonly inner: string; readonly end: number } | undefined {
  if (!text.startsWith(open, index)) return undefined;
  const closeAt = text.indexOf(close, index + open.length);
  if (closeAt === -1) return undefined;
  return { inner: text.slice(index + open.length, closeAt), end: closeAt + close.length };
}

function styledSegment(text: string, fg: string, marks: InlineMarks): Segment {
  return {
    text,
    fg,
    ...(marks.bold === true ? { bold: true } : {}),
    ...(marks.italic === true ? { italic: true } : {}),
    ...(marks.underline === true ? { underline: true } : {}),
    ...(marks.strikethrough === true ? { strikethrough: true } : {}),
  };
}

function parseInline(text: string, fg: string, glyphs: GlyphSet, marks: InlineMarks): Segment[] {
  const segments: Segment[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = (): void => {
    if (plain.length === 0) return;
    if (
      marks.bold === true ||
      marks.italic === true ||
      marks.underline === true ||
      marks.strikethrough === true
    ) {
      segments.push(styledSegment(plain, fg, marks));
    } else {
      segments.push(...citations(plain, fg, glyphs));
    }
    plain = "";
  };

  const takeMarked = (inner: string, extra: InlineMarks, nextIndex: number): void => {
    flushPlain();
    if (inner.length > 0) {
      segments.push(...parseInline(inner, fg, glyphs, { ...marks, ...extra }));
    }
    index = nextIndex;
  };

  while (index < text.length) {
    if (text[index] === "\\" && index + 1 < text.length) {
      plain += text[index + 1];
      index += 2;
      continue;
    }

    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close !== -1) {
        flushPlain();
        const code = text.slice(index + 1, close);
        if (code.length > 0) segments.push({ text: code, fg: THEME.syntaxValue });
        index = close + 1;
        continue;
      }
    }

    const link = matchLink(text, index);
    if (link !== undefined) {
      flushPlain();
      if (link.label.length > 0) segments.push({ text: link.label, fg: THEME.link });
      index = link.end;
      continue;
    }

    const under = matchWrapped(text, index, "<u>", "</u>");
    if (under !== undefined) {
      takeMarked(under.inner, { underline: true }, under.end);
      continue;
    }

    const struck = matchWrapped(text, index, "~~", "~~");
    if (struck !== undefined) {
      takeMarked(struck.inner, { strikethrough: true }, struck.end);
      continue;
    }

    const stars = delimiterRunLength(text, index, "*");
    if (stars >= 1) {
      const size = Math.min(stars, 3);
      const marker = "*".repeat(size);
      const closeAt = findDelimiterClose(text, index + size, marker);
      if (closeAt !== -1) {
        const extra: InlineMarks =
          size === 3
            ? { bold: true, italic: true }
            : size === 2
              ? { bold: true }
              : { italic: true };
        takeMarked(text.slice(index + size, closeAt), extra, closeAt + size);
        continue;
      }
    }

    const unders = delimiterRunLength(text, index, "_");
    if (unders >= 2) {
      const size = Math.min(unders, 3);
      const marker = "_".repeat(size);
      const closeAt = findDelimiterClose(text, index + size, marker);
      if (closeAt !== -1) {
        const extra: InlineMarks = size === 3 ? { bold: true, italic: true } : { bold: true };
        takeMarked(text.slice(index + size, closeAt), extra, closeAt + size);
        continue;
      }
    }
    if (unders === 1 && canOpenUnderscoreItalic(text, index)) {
      const closeAt = findUnderscoreItalicClose(text, index + 1);
      if (closeAt !== -1) {
        takeMarked(text.slice(index + 1, closeAt), { italic: true }, closeAt + 1);
        continue;
      }
    }

    plain += text[index];
    index += 1;
  }

  flushPlain();
  return segments;
}

/** Inline emphasis, code, links and citations, as styled spans. */
export function inlineSegments(
  text: string,
  fg: string,
  glyphs: GlyphSet = getGlyphs(),
): Segment[] {
  return parseInline(text, fg, glyphs, {});
}

/** A citation is a pointer, not prose, so it drops to the dimmed accent. */
function citations(text: string, fg: string, glyphs: GlyphSet): Segment[] {
  const pattern = new RegExp(`(${glyphs.citeOpen}[^${glyphs.citeClose}]*${glyphs.citeClose})`);
  return text
    .split(pattern)
    .filter((piece) => piece.length > 0)
    .map((piece) =>
      piece.startsWith(glyphs.citeOpen)
        ? { text: piece, fg: THEME.accentDim }
        : { text: piece, fg },
    );
}

function headingMarker(level: number, glyphs: GlyphSet): string {
  if (level <= 1) return glyphs.heading1;
  if (level === 2) return glyphs.heading2;
  if (level === 3) return glyphs.heading3;
  return glyphs.heading4;
}

/**
 * Split agent markdown into items that read at the measure and items that scan.
 * CommonMark ordered markers (`1.` and `1)`) start a new item even without a blank line.
 */
export function parseProse(markdown: string, glyphs: GlyphSet = getGlyphs()): ProseItem[] {
  const items: ProseItem[] = [];
  const lines = markdown.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      items.push({ kind: "blank" });
      index += 1;
      continue;
    }

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      items.push({
        kind: "fence",
        language: (fence[1] ?? "").trim().split(/\s+/)[0] ?? "",
        lines: body,
      });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      items.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) {
        const raw = (lines[index] ?? "").trim();
        // The `| --- | --- |` alignment row is markdown syntax, not data.
        if (!/^\|[\s|:-]+\|?$/.test(raw)) {
          rows.push(
            raw
              .replace(/^\|/, "")
              .replace(/\|$/, "")
              .split("|")
              .map((cell) => cell.trim()),
          );
        }
        index += 1;
      }
      items.push({ kind: "table", rows });
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      items.push({
        kind: "text",
        indent: 0,
        segments: [
          { text: `${headingMarker(level, glyphs)} `, fg: THEME.border },
          ...inlineSegments(heading[2] ?? "", THEME.selected, glyphs).map((segment) => ({
            ...segment,
            bold: true,
          })),
        ],
      });
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      items.push({
        kind: "text",
        indent: 2,
        segments: [
          { text: `${glyphs.blockquote} `, fg: THEME.border },
          ...inlineSegments(quote[1] ?? "", THEME.secondary, glyphs),
        ],
      });
      index += 1;
      continue;
    }

    const bullet = /^(\s*)(?:[-*+]|\d+\.|(\d+\)))\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const depth = Math.floor(terminalCellWidth(bullet[1] ?? "") / 2);
      const paren = bullet[2];
      items.push({
        kind: "text",
        indent: depth * 2 + (paren !== undefined ? 0 : 2),
        segments: [
          { text: `${paren ?? glyphs.bullet} `, fg: THEME.border },
          ...inlineSegments(bullet[3] ?? "", THEME.selected, glyphs),
        ],
      });
      index += 1;
      continue;
    }

    // A paragraph runs until a blank line or a line that starts a new item.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (
        candidate.trim().length === 0 ||
        /^\s*(\||```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidate.trim());
      index += 1;
    }
    items.push({
      kind: "text",
      indent: 0,
      segments: inlineSegments(paragraph.join(" "), THEME.selected, glyphs),
    });
  }

  return items;
}

/**
 * Gaps first, then columns: a table that is wider than the measure must still
 * keep every column. Flooring a proportional scale (and a min of 3) used to
 * overflow the row, after which `fitTerminalSegments` ate the last cells.
 */
function tableColumnLayout(
  natural: readonly number[],
  width: number,
): { readonly sizes: readonly number[]; readonly gap: number } {
  const columns = natural.length;
  if (columns === 0) return { sizes: [], gap: 0 };

  let gap = columns > 1 ? RECEIPT_GAP : 0;
  let available = width - gap * Math.max(0, columns - 1);
  while (gap > 0 && available < columns) {
    gap -= 1;
    available = width - gap * (columns - 1);
  }
  available = Math.max(columns, available);

  const total = natural.reduce((sum, size) => sum + size, 0);
  const floor = available < columns * 3 ? 1 : 3;
  const sizes = natural.map((size) => {
    if (total <= available) return Math.max(size, 1);
    return Math.max(floor, Math.floor((size / total) * available));
  });

  let used = sizes.reduce((sum, size) => sum + size, 0);
  while (used > available) {
    let widest = 0;
    for (let index = 1; index < sizes.length; index += 1) {
      if ((sizes[index] ?? 0) > (sizes[widest] ?? 0)) widest = index;
    }
    if ((sizes[widest] ?? 0) <= 1) break;
    sizes[widest] = (sizes[widest] ?? 1) - 1;
    used -= 1;
  }

  let leftover = available - used;
  while (leftover > 0) {
    let grown = false;
    for (let index = 0; index < sizes.length; index += 1) {
      if (leftover === 0) break;
      if ((sizes[index] ?? 0) < (natural[index] ?? 0)) {
        sizes[index] = (sizes[index] ?? 0) + 1;
        leftover -= 1;
        grown = true;
      }
    }
    if (!grown) break;
  }

  return { sizes, gap };
}

function padTableCell(lines: Segment[][], size: number, fg: string, lineIndex: number): Segment[] {
  const line = lines[lineIndex];
  if (line === undefined || line.length === 0) {
    return [{ text: " ".repeat(size), fg }];
  }
  const used = terminalSegmentsWidth(line);
  const pad = Math.max(0, size - used);
  return pad > 0 ? [...line, { text: " ".repeat(pad), fg }] : line;
}

/** Borderless columns: a table is scanned, so its chrome is whitespace. */
function tableRows(
  rows: readonly (readonly string[])[],
  width: number,
  key: string,
  rail: Segment,
): RenderRow[] {
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => terminalCellWidth(row[column] ?? "")), 1),
  );
  const { sizes, gap } = tableColumnLayout(natural, width);

  const rendered: RenderRow[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;
    const fg = rowIndex === 0 ? THEME.muted : THEME.secondary;
    const wrapped = Array.from({ length: columns }, (_, column) => {
      const size = sizes[column] ?? 1;
      return wrap([{ text: row[column] ?? "", fg }], size);
    });
    const height = Math.max(...wrapped.map((cell) => cell.length), 1);
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const segments: Segment[] = [];
      wrapped.forEach((cell, column) => {
        segments.push(...padTableCell(cell, sizes[column] ?? 1, fg, lineIndex));
        if (column < columns - 1) segments.push({ text: " ".repeat(gap), fg });
      });
      rendered.push({
        key: `${key}:table:${String(rowIndex)}:${String(lineIndex)}`,
        gutter: [rail, BLANK_CELL],
        content: fitTerminalSegments(segments, width),
        contentWidth: width,
        meta: [],
      });
    }
    if (rowIndex < rows.length - 1) {
      rendered.push({
        key: `${key}:table:${String(rowIndex)}:gap`,
        gutter: [rail, BLANK_CELL],
        content: [],
        contentWidth: width,
        meta: [],
      });
    }
  }
  return rendered;
}

// ─── Blocks to rows ──────────────────────────────────────────────────────────

const BLANK_CELL: Segment = { text: " ", fg: THEME.border };

function railCell(color: string, glyphs: GlyphSet, deep = false): Segment {
  return { text: deep ? glyphs.railDeep : glyphs.rail, fg: color };
}

function blankRow(key: string, contentWidth: number, glyphs: GlyphSet): RenderRow {
  return {
    key,
    gutter: [railCell(THEME.border, glyphs), BLANK_CELL],
    content: [],
    contentWidth,
    meta: [],
  };
}

/**
 * Which blocks open with a blank row. Prose always does — vertical space is the
 * cheapest legibility on offer — and so does the first block of any other
 * family, which is what keeps a run of receipts tight while still separating it
 * from the answer above.
 */
function family(block: Block): string {
  switch (block.kind) {
    case "user":
    case "agent":
      return block.kind;
    case "tool":
    case "notice":
      return "receipt";
    default:
      return block.kind;
  }
}

function needsBreathingRow(block: Block, previous: Block | undefined): boolean {
  if (previous === undefined) return false;
  if (block.kind === "user" || block.kind === "agent") return true;
  // Same-family receipts stay tight; consecutive reasoning does not.
  // Ctrl+R expands each thought in place, and without a gap two walls of
  // text read as one.
  if (block.kind === "reasoning" && previous.kind === "reasoning") return true;
  return family(block) !== family(previous);
}

interface Geometry {
  readonly prose: number;
  readonly content: number;
  readonly metadata: number;
}

interface RunCacheEntry {
  readonly run: readonly ToolReceiptBlock[];
  readonly rows: readonly RenderRow[];
}

// Streaming replaces the last Block, so useMemo re-enters transcriptRows for
// the whole conversation. Cache wrap/highlight per block so only the dirty tail
// misses.
//
// The cache is keyed on the Block object itself, and finding an entry is the
// whole validity check: `shareUnchangedBlocks` in the bridge hands back the
// previous Block whenever its content is unchanged, so a fresh object means
// fresh content and reference equality catches every edit. Comparing content
// instead meant a JSON.stringify of every block's full text on every frame,
// which was the entire warm cost of a streamed frame once #395 landed. Keying
// weakly also retires an entry with the block it wrapped, so nothing evicts.
let blockRowsCache = new WeakMap<Block, readonly RenderRow[]>();
let runRowsCache = new WeakMap<ToolReceiptBlock, RunCacheEntry>();
let wrapCacheEpoch: string | undefined;
let lastTranscriptBlocks: readonly Block[] | undefined;
let lastTranscriptEpoch: string | undefined;
let lastTranscriptRows: RenderRow[] | undefined;

function wrapEpoch(width: number, glyphs: GlyphSet): string {
  // Cached rows bake THEME colors at wrap time, so a variant switch must
  // invalidate them the same way a resize does.
  return `${String(width)}\0${getThemeVariant()}\0${glyphs.rail}\0${glyphs.divider}\0${glyphs.bullet}\0${glyphs.diamond}`;
}

function sameRun(
  cached: readonly ToolReceiptBlock[],
  current: readonly ToolReceiptBlock[],
): boolean {
  if (cached.length !== current.length) return false;
  for (let index = 0; index < cached.length; index += 1) {
    if (cached[index] !== current[index]) return false;
  }
  return true;
}

function cachedBlockRows(
  block: Exclude<Block, ToolReceiptBlock>,
  compute: () => RenderRow[],
): readonly RenderRow[] {
  const hit = blockRowsCache.get(block);
  if (hit !== undefined) return hit;
  const rows = compute();
  blockRowsCache.set(block, rows);
  return rows;
}

// A run of consecutive receipts wraps as one unit, keyed on its head. The rest
// of the run still needs comparing: growing or shrinking a run leaves the head
// in place, and only its members say how far the shared wrap reached.
function cachedRunRows(
  run: readonly ToolReceiptBlock[],
  head: ToolReceiptBlock,
  compute: () => RenderRow[],
): readonly RenderRow[] {
  const hit = runRowsCache.get(head);
  if (hit !== undefined && sameRun(hit.run, run)) return hit.rows;
  const rows = compute();
  runRowsCache.set(head, { run, rows });
  return rows;
}

function appendRows(target: RenderRow[], source: readonly RenderRow[]): void {
  for (let index = 0; index < source.length; index += 1) {
    const row = source[index];
    if (row !== undefined) target.push(row);
  }
}

function rowsForBlock(
  block: Exclude<Block, ToolReceiptBlock>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  switch (block.kind) {
    case "user":
      return userRows(block, geometry, glyphs);
    case "agent":
      return agentRows(block, geometry, glyphs);
    case "reasoning":
      return reasoningRows(block, geometry, glyphs);
    case "notice":
      return noticeRows(block, geometry, glyphs);
    case "divider":
      return dividerRows(block, geometry, glyphs);
    case "lane":
      return laneRows(block, geometry, glyphs);
  }
}

function userRows(
  block: Extract<Block, { kind: "user" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const rail = railCell(THEME.border, glyphs);
  const meta: readonly Segment[] =
    block.at !== undefined && geometry.metadata > 0 ? [{ text: block.at, fg: THEME.muted }] : [];
  // What you typed is an echo; the agent's answer is the bright thing on screen.
  const lines = wrap([{ text: block.text, fg: THEME.secondary }], geometry.prose);
  const rows: RenderRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    rows.push({
      key: `${block.id}:${String(index)}`,
      gutter: [index === 0 ? { text: glyphs.promptCursor, fg: THEME.primary } : rail, BLANK_CELL],
      content: line,
      contentWidth: geometry.prose,
      meta: index === 0 ? meta : [],
    });
  }
  return rows;
}

function agentRows(
  block: Extract<Block, { kind: "agent" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  // Colour is state, not speaker: the rail is accent only while tokens land.
  const railColor = block.streaming === true ? THEME.agent : THEME.border;
  const rail = railCell(railColor, glyphs);
  const marker: Segment = {
    text: glyphs.diamond,
    fg: block.streaming === true ? THEME.agent : THEME.secondary,
  };

  const rows: RenderRow[] = [];
  let first = true;
  const gutterFor = (): readonly Segment[] => {
    const gutter = [first ? marker : rail, BLANK_CELL];
    first = false;
    return gutter;
  };

  const items = parseProse(block.markdown, glyphs);
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (item === undefined) continue;
    const key = `${block.id}:${String(itemIndex)}`;
    switch (item.kind) {
      case "blank":
        rows.push({
          key,
          gutter: gutterFor(),
          content: [],
          contentWidth: geometry.prose,
          meta: [],
        });
        break;
      case "rule":
        rows.push({
          key,
          gutter: gutterFor(),
          content: [{ text: glyphs.divider.repeat(geometry.prose), fg: THEME.border }],
          contentWidth: geometry.prose,
          meta: [],
        });
        break;
      case "fence": {
        const painted = highlightFenceLines(item.language, item.lines);
        for (let lineIndex = 0; lineIndex < painted.length; lineIndex += 1) {
          const spans = painted[lineIndex];
          if (spans === undefined) continue;
          rows.push({
            key: `${key}:${String(lineIndex)}`,
            gutter: gutterFor(),
            content: fitTerminalSegments([...spans], geometry.content),
            contentWidth: geometry.content,
            meta: [],
          });
        }
        break;
      }
      case "table": {
        const table = tableRows(item.rows, geometry.content, key, rail);
        for (let tableIndex = 0; tableIndex < table.length; tableIndex += 1) {
          const row = table[tableIndex];
          if (row !== undefined) rows.push(row);
        }
        first = false;
        break;
      }
      default: {
        const indent = item.indent;
        const lines = wrap(item.segments, geometry.prose - indent);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) continue;
          const padded =
            indent > 0 ? [{ text: " ".repeat(indent), fg: THEME.border }, ...line] : line;
          rows.push({
            key: `${key}:${String(lineIndex)}`,
            gutter: gutterFor(),
            content: padded,
            contentWidth: geometry.prose,
            meta: [],
          });
        }
      }
    }
  }

  return rows;
}

function reasoningRows(
  block: Extract<Block, { kind: "reasoning" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const rail = railCell(THEME.border, glyphs, true);
  const meta: readonly Segment[] =
    block.durationMs !== undefined && geometry.metadata > 0
      ? [{ text: formatDuration(block.durationMs), fg: THEME.muted }]
      : [];

  if (block.collapsed) {
    const steps = block.steps ?? 0;
    const parts = [steps > 0 ? `thought ${String(steps)} steps` : "thought", "ctrl+r expands"];
    return [
      {
        key: `${block.id}:0`,
        gutter: [rail, BLANK_CELL],
        content: [
          {
            text: `${" ".repeat(REASONING_INDENT)}${parts.join(` ${glyphs.bullet} `)}`,
            fg: THEME.muted,
          },
        ],
        contentWidth: geometry.prose,
        meta,
      },
    ];
  }

  // Subordinate by geometry, not by a new hue: narrower, indented, never bold.
  const measure = Math.max(24, Math.floor(geometry.prose * REASONING_MEASURE_RATIO));
  const text = spaceReasoningSections(block.text);
  const lines = wrap([{ text, fg: THEME.muted }], measure - REASONING_INDENT);
  const rows: RenderRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    rows.push({
      key: `${block.id}:${String(index)}`,
      gutter: [rail, BLANK_CELL],
      content: [{ text: " ".repeat(REASONING_INDENT), fg: THEME.border }, ...line],
      contentWidth: geometry.prose,
      meta: index === 0 ? meta : [],
    });
  }
  return rows;
}

/**
 * True when `summary` is the same text as `reason`, possibly clipped with an
 * ellipsis. Production used to put `tool: error` in both fields, which then
 * ate the row twice and still cropped the actual sentence.
 */
function summaryRestatesReason(summary: string, reason: string): boolean {
  const stripped = summary.replace(/…$/u, "").trim();
  if (stripped.length === 0) return false;
  if (stripped === reason) return true;
  const head = reason.slice(0, Math.min(48, reason.length));
  return head.length > 0 && stripped.includes(head);
}

function highlightedArgs(args: string, fallbackFg: string, app: string): Segment[] {
  const path = pathFromFileArgsPreview(args);
  const language = path === undefined ? undefined : sourceLanguageFromPath(path);
  if (language === undefined && !isFileMutationTool(app)) {
    return [{ text: `  ${args}`, fg: fallbackFg }];
  }
  return [{ text: "  ", fg: fallbackFg }, ...highlightCodeLine(args)];
}

/** A settled receipt: what it did and what came back, and nothing else. */
function receiptSegments(block: ToolReceiptBlock, glyphs: GlyphSet): Segment[] {
  const args = block.args?.trim();
  const summary = block.summary.trim();
  if (block.status === "ok") {
    const segments: Segment[] = [];
    if (block.app.length > 0) {
      segments.push({ text: block.app, fg: THEME.muted });
    }
    if (args !== undefined && args.length > 0) {
      segments.push(...highlightedArgs(args, THEME.secondary, block.app));
    }
    if (summary.length > 0) {
      segments.push({ text: `  ${summary}`, fg: THEME.muted });
    }
    if (block.classifiedRisk !== undefined) {
      segments.push({ text: ` ${glyphs.bullet} ${block.classifiedRisk}`, fg: THEME.muted });
    }
    return segments;
  }
  // Failure keeps a colour and states the reason inline. A short reason stays
  // on the same row as the app; a long one wraps rather than cropping.
  const tone = block.status === "denied" ? THEME.warning : THEME.error;
  const reason = block.reason?.trim();
  const segments: Segment[] = [{ text: block.app, fg: tone }];
  if (args !== undefined && args.length > 0) {
    segments.push({ text: `  ${args}`, fg: tone });
  }
  if (summary.length > 0 && (reason === undefined || !summaryRestatesReason(summary, reason))) {
    segments.push({ text: `  ${summary}`, fg: tone });
  }
  if (reason !== undefined && reason.length > 0) {
    segments.push({ text: ` ${glyphs.bullet} ${reason}`, fg: THEME.secondary });
  }
  if (block.remedyKey !== undefined) {
    segments.push({ text: ` ${glyphs.bullet} ${block.remedyKey}`, fg: THEME.muted });
  }
  if (block.classifiedRisk !== undefined) {
    segments.push({ text: ` ${glyphs.bullet} ${block.classifiedRisk}`, fg: THEME.muted });
  }
  return segments;
}

/**
 * Consecutive settled receipts pack onto shared rows; anything that failed, was
 * denied, or is expanded takes its own row, because those are the ones a reader
 * has to stop on.
 */
function receiptRows(
  blocks: readonly ToolReceiptBlock[],
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const rail = railCell(THEME.border, glyphs);
  const rows: RenderRow[] = [];
  let packed: Segment[] = [];
  let packedKey = "";

  const flush = (): void => {
    if (packed.length === 0) return;
    rows.push({
      key: `${packedKey}:packed`,
      gutter: [rail, BLANK_CELL],
      content: packed,
      contentWidth: geometry.prose,
      meta: [],
    });
    packed = [];
    packedKey = "";
  };

  for (const block of blocks) {
    const segments = receiptSegments(block, glyphs);
    const solo = block.status !== "ok" || block.expanded === true;

    if (solo) {
      flush();
      const marker =
        block.status === "denied"
          ? { text: glyphs.proposed, fg: THEME.warning }
          : block.status === "failed"
            ? { text: glyphs.error, fg: THEME.error }
            : { text: glyphs.pending, fg: THEME.muted };
      const meta: readonly Segment[] =
        block.expanded === true && block.durationMs !== undefined && geometry.metadata > 0
          ? [{ text: formatDuration(block.durationMs), fg: THEME.muted }]
          : [];
      if (segments.some((segment) => segment.text.trim().length > 0)) {
        const lines = wrap(segments, geometry.prose);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) continue;
          rows.push({
            key: `${block.id}:${String(lineIndex)}`,
            gutter: [lineIndex === 0 && block.status !== "ok" ? marker : rail, BLANK_CELL],
            content: line,
            contentWidth: geometry.prose,
            meta: lineIndex === 0 ? meta : [],
          });
        }
      }
      if (block.expanded === true && block.detail !== undefined) {
        const detailLines = block.detail.split("\n");
        const painted = highlightFenceLines("", detailLines);
        for (let index = 0; index < painted.length; index += 1) {
          const spans = painted[index];
          if (spans === undefined) continue;
          rows.push({
            key: `${block.id}:detail:${String(index)}`,
            gutter: [rail, BLANK_CELL],
            content: fitTerminalSegments([...spans], geometry.content),
            contentWidth: geometry.content,
            meta: [],
          });
        }
      }
      continue;
    }

    const size = terminalSegmentsWidth(segments);
    const used = terminalSegmentsWidth(packed);
    if (used > 0 && used + RECEIPT_GAP * 2 + size > geometry.prose) flush();
    if (terminalSegmentsWidth(packed) > 0) {
      packed.push({ text: `  ${glyphs.bullet} `, fg: THEME.border });
    } else {
      packedKey = block.id;
    }
    packed.push(...segments);
  }
  flush();
  return rows;
}

function noticeRows(
  block: Extract<Block, { kind: "notice" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const tone =
    block.tone === "error" ? THEME.error : block.tone === "warn" ? THEME.warning : THEME.info;
  const glyph =
    block.tone === "error" ? glyphs.error : block.tone === "warn" ? glyphs.warn : glyphs.info;
  const lines = wrap([{ text: block.text, fg: tone }], geometry.prose);
  const rows: RenderRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    rows.push({
      key: `${block.id}:${String(index)}`,
      gutter: [
        index === 0 ? { text: glyph, fg: tone } : railCell(THEME.border, glyphs),
        BLANK_CELL,
      ],
      content: line,
      contentWidth: geometry.prose,
      meta: [],
    });
  }
  return rows;
}

function dividerRows(
  block: Extract<Block, { kind: "divider" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const label = block.label.length > 0 ? `${block.label} ` : "";
  const rule = glyphs.divider.repeat(Math.max(0, geometry.content - terminalCellWidth(label)));
  return [
    {
      key: `${block.id}:0`,
      gutter: [railCell(THEME.border, glyphs), BLANK_CELL],
      content: [
        { text: label, fg: THEME.muted },
        { text: rule, fg: THEME.border },
      ],
      contentWidth: geometry.content,
      meta: [],
    },
  ];
}

/**
 * A lane gets a *column*, not an indent, so depth costs no measure and the
 * content column never moves.
 *
 * The lane's number lives in the metadata column rather than in that gutter
 * cell. Printed in the gutter it abutted the name and read as one token —
 * `1travel-scout` — which is worse than not distinguishing the lanes at all.
 * An identifier is metadata, and the metadata column is where metadata goes.
 */
function laneRows(
  block: Extract<Block, { kind: "lane" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const live = block.state === "running";
  const railColor = live ? THEME.accentDim : THEME.border;
  const rail = railCell(railColor, glyphs, true);
  // Holds the gutter at two cells so every block's content starts in the same
  // column, whether or not it is delegated.
  const tag: Segment = { text: " ", fg: THEME.border };
  const marker: Segment = live
    ? { text: glyphs.pending, fg: THEME.accentDim }
    : block.state === "failed"
      ? { text: glyphs.error, fg: THEME.error }
      : { text: glyphs.success, fg: THEME.secondary };

  const meta: readonly Segment[] =
    geometry.metadata > 0
      ? [
          {
            text:
              block.steps === undefined
                ? `lane ${String(block.lane)}`
                : `lane ${String(block.lane)} ${glyphs.bullet} ${String(block.steps)} steps`,
            fg: THEME.muted,
          },
        ]
      : [];

  const rows: RenderRow[] = [
    {
      key: `${block.id}:0`,
      gutter: [marker, tag],
      content: fitTerminalSegments(
        [
          { text: block.name, fg: THEME.secondary },
          { text: `  ${block.ask}`, fg: THEME.muted },
        ],
        geometry.prose,
      ),
      contentWidth: geometry.prose,
      meta,
    },
  ];

  if (block.result !== undefined) {
    const lines = wrap([{ text: block.result, fg: THEME.secondary }], geometry.prose - 2);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      rows.push({
        key: `${block.id}:result:${String(index)}`,
        gutter: [index === 0 ? { text: glyphs.laneEnd, fg: THEME.border } : rail, tag],
        content: [{ text: " ".repeat(2), fg: THEME.border }, ...line],
        contentWidth: geometry.prose,
        meta: [],
      });
    }
  }

  return rows;
}

/**
 * The width the transcript lays out on: the terminal, minus nothing but the
 * rail and right margin that `measureFor` already subtracts. There is no page
 * cap — unused columns past 120 were empty space, not a reading measure.
 */
export function pageWidth(viewport: Viewport): number {
  return viewport.width;
}

/** The whole transcript as physical rows. Pure: blocks and a width, nothing else. */
export function transcriptRows(blocks: readonly Block[], viewport: Viewport): RenderRow[] {
  const width = pageWidth(viewport);
  const glyphs = getGlyphs();
  const epoch = wrapEpoch(width, glyphs);
  if (
    blocks === lastTranscriptBlocks &&
    epoch === lastTranscriptEpoch &&
    lastTranscriptRows !== undefined
  ) {
    return lastTranscriptRows;
  }

  if (wrapCacheEpoch !== epoch) {
    blockRowsCache = new WeakMap();
    runRowsCache = new WeakMap();
    wrapCacheEpoch = epoch;
  }

  const measure = measureFor(width);
  const geometry: Geometry = {
    prose: measure.prose,
    content: measure.prose + measure.metadata,
    metadata: measure.metadata,
  };

  const rows: RenderRow[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (block === undefined) break;
    if (needsBreathingRow(block, blocks[index - 1])) {
      rows.push(blankRow(`gap:${block.id}`, geometry.prose, glyphs));
    }

    if (block.kind === "tool") {
      const run: ToolReceiptBlock[] = [];
      while (index < blocks.length) {
        const candidate = blocks[index];
        if (candidate === undefined || candidate.kind !== "tool") break;
        run.push(candidate);
        index += 1;
      }
      appendRows(
        rows,
        cachedRunRows(run, block, () => receiptRows(run, geometry, glyphs)),
      );
      continue;
    }

    appendRows(
      rows,
      cachedBlockRows(block, () => rowsForBlock(block, geometry, glyphs)),
    );
    index += 1;
  }

  lastTranscriptBlocks = blocks;
  lastTranscriptEpoch = epoch;
  lastTranscriptRows = rows;
  return rows;
}

// ─── The region ──────────────────────────────────────────────────────────────

function Spans({ segments }: { segments: readonly Segment[] }): ReactNode {
  if (segments.length === 0) return null;
  return (
    <text style={{ wrapMode: "none", truncate: true }}>
      {segments.map((segment, index) => {
        const attributes = segmentAttributes(segment);
        return (
          <span
            key={`${String(index)}:${segment.text}`}
            style={{
              fg: segment.fg,
              // OpenTUI text nodes honour `attributes`, not `bold`/`italic` booleans.
              ...(attributes === 0 ? {} : { attributes }),
            }}
          >
            {segment.text}
          </span>
        );
      })}
    </text>
  );
}

function Row({ row, width }: { row: RenderRow; width: number }): ReactNode {
  return (
    <box style={{ width, height: 1, flexShrink: 0, flexDirection: "row" }}>
      <box style={{ width: GUTTER, flexShrink: 0 }}>
        <Spans segments={row.gutter} />
      </box>
      <box style={{ width: row.contentWidth, flexShrink: 0 }}>
        <Spans segments={row.content} />
      </box>
      <box style={{ flexGrow: 1 }} />
      <box style={{ flexShrink: 0 }}>
        <Spans segments={row.meta} />
      </box>
      <box style={{ width: RIGHT_MARGIN, flexShrink: 0 }} />
    </box>
  );
}

export interface TranscriptProps {
  readonly blocks: readonly Block[];
  readonly viewport: Viewport;
  readonly focus: Focus;
  /** Set while the reader is scrolled away from the live edge. */
  readonly newBelow?: number;
  /** Stick to the newest row. False once the reader has taken the scroll. */
  readonly followLive?: boolean;
  /**
   * Rows the transcript may paint. Defaults to `viewport.height` for standalone
   * tests; the shell passes the leftover after chrome, live band, and composer.
   */
  readonly visibleCount?: number;
}

export interface TranscriptHandle {
  scrollBy(delta: number, unit?: "line" | "page" | "end"): void;
}

const TranscriptView = forwardRef<TranscriptHandle, TranscriptProps>(function Transcript(
  { blocks, viewport, focus, newBelow, followLive = true, visibleCount },
  ref,
): ReactNode {
  // Deriving rows re-parses every block's markdown, tables and fences. The
  // shell re-renders on each streaming delta and each keystroke, so without
  // this the cost of a frame grows with the length of the whole conversation
  // rather than with what changed.
  const rows = useMemo(() => transcriptRows(blocks, viewport), [blocks, viewport.width]);
  const page = pageWidth(viewport);
  const windowHeight =
    visibleCount === undefined ? Math.max(1, viewport.height) : Math.max(0, visibleCount);
  const [, setScrollVersion] = useState(0);
  const scrollFromBottomRef = useRef(0);
  const rowsRef = useRef(rows);
  const heightRef = useRef(windowHeight);
  const rowCountRef = useRef(rows.length);
  rowsRef.current = rows;
  heightRef.current = windowHeight;

  if (followLive) {
    scrollFromBottomRef.current = 0;
  } else if (rows.length !== rowCountRef.current) {
    const growth = rows.length - rowCountRef.current;
    if (growth > 0) scrollFromBottomRef.current += growth;
  }
  rowCountRef.current = rows.length;

  const offset = clampScrollFromBottom(scrollFromBottomRef.current, rows.length, windowHeight);
  const visible = windowTranscriptRows(rows, windowHeight, offset);
  const padCount = Math.max(0, windowHeight - visible.length);

  useImperativeHandle(ref, () => ({
    scrollBy(delta: number, unit: "line" | "page" | "end" = "line"): void {
      const currentRows = rowsRef.current;
      const next = applyScrollDelta(
        scrollFromBottomRef.current,
        currentRows.length,
        heightRef.current,
        delta,
        unit,
      );
      if (next === scrollFromBottomRef.current) return;
      scrollFromBottomRef.current = next;
      setScrollVersion((version) => version + 1);
    },
  }));

  const marker =
    newBelow !== undefined && newBelow > 0 ? `${String(newBelow)} new below  end jumps` : undefined;

  return (
    <box
      style={{
        width: viewport.width,
        height: windowHeight,
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        maxHeight: windowHeight,
        overflow: "hidden",
        flexDirection: "column",
      }}
    >
      {/* OpenTUI only settles this region's layout when a scrollbox owns it.
          Sticky scroll is off: we window the rows ourselves so wheel and
          keyboard offsets are not snapped back to the live edge. */}
      <scrollbox
        focused={focus === "transcript"}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          height: windowHeight,
          overflow: "hidden",
        }}
        stickyScroll={false}
        scrollY={false}
        scrollbarOptions={{ visible: false }}
      >
        {Array.from({ length: padCount }, (_, index) => (
          <box
            key={`pad:${String(index)}`}
            style={{ width: page, height: 1, flexShrink: 0 }}
          />
        ))}
        {visible.map((row) => (
          <Row
            key={row.key}
            row={row}
            width={page}
          />
        ))}
      </scrollbox>

      {/* Overlay rather than a layout row so the transcript does not shift
          under the reader when the count appears. */}
      {marker === undefined ? null : (
        <box
          style={{
            position: "absolute",
            bottom: 0,
            right: viewport.width - page + RIGHT_MARGIN,
            height: 1,
            flexDirection: "row",
          }}
        >
          <text style={{ fg: THEME.primary }}>{marker}</text>
        </box>
      )}
    </box>
  );
});

export const Transcript = memo(TranscriptView);
