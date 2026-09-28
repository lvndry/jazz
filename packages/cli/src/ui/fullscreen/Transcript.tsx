/** @jsxImportSource @opentui/react */

/**
 * The transcript: the one region that is actually *read* rather than glanced at.
 *
 * Two decisions carry the whole design.
 *
 * The first is the measure. Running prose stops at `PROSE_MEASURE` however
 * wide the window is, with a short metadata strip directly beside it for
 * timestamps, so a sentence and its metadata never collide and the eye always
 * returns to the same left edge. Tool output, tables and code fences may take
 * the full content width — those are scanned, not read, and a table squeezed
 * to the prose measure is worse than a table that reaches the frame.
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
 *   beside       metadata, right-aligned in the strip that follows the prose measure
 *
 * Rows are pre-wrapped here rather than left to the renderer, because the rail
 * has to appear on every row of a block and the wrap point is what guarantees
 * the measure. `transcriptRows` is therefore a pure function of the blocks and
 * the viewport, and is what the tests assert against.
 */

import { isFileMutationTool } from "@jazz/core/utils/tool-formatter";
import { TextAttributes, type MouseEvent as OTMouseEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  createContext,
  forwardRef,
  memo,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  continueFenceHighlight,
  highlightCodeLine,
  highlightFenceLines,
  pathFromFileArgsPreview,
  sourceLanguageFromPath,
  type FenceHighlight,
  type SyntaxSpan,
} from "./syntax-spans";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { getThemeRevision, THEME } from "../theme";
import { linkAtColumn, openLink } from "./open-link";
import {
  fitTerminalSegments,
  sliceTerminalCells,
  terminalCellWidth,
  terminalGraphemes,
  terminalSegmentsWidth,
} from "./terminal-cells";
import { useThemeRevision } from "./theme-revision";
import { applyScrollDelta, clampScrollFromBottom, windowTranscriptRows } from "./transcript-window";
import {
  measureFor,
  PROSE_MEASURE,
  type Block,
  type Focus,
  type ToolReceiptBlock,
  type Viewport,
} from "./types";
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
  readonly link?: string;
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
    previous.strikethrough === current.strikethrough &&
    previous.link === current.link
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
  /**
   * A surface painted behind exactly `contentWidth` cells, so a band ends on
   * the measure rather than at the window edge. `bandIncludesGutter` extends
   * it left over the rail and lane cells.
   */
  readonly backgroundColor?: string;
  readonly bandIncludesGutter?: boolean;
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
  | {
      readonly kind: "text";
      readonly segments: readonly Segment[];
      readonly indent: number;
      /**
       * A list marker or quote bar that opens the first row. Wrapped rows
       * hang under the text after it, or repeat it when `repeatMarker` is set.
       */
      readonly marker?: Segment;
      readonly repeatMarker?: boolean;
    }
  | { readonly kind: "heading"; readonly level: number; readonly segments: readonly Segment[] }
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
): { readonly label: string; readonly url: string; readonly end: number } | undefined {
  if (text[index] !== "[") return undefined;
  const close = text.indexOf("]", index + 1);
  if (close === -1 || text[close + 1] !== "(") return undefined;
  const urlEnd = text.indexOf(")", close + 2);
  if (urlEnd === -1) return undefined;
  return {
    label: text.slice(index + 1, close),
    url: text.slice(close + 2, urlEnd).trim(),
    end: urlEnd + 1,
  };
}

/** Punctuation that ends a sentence rather than a URL: `see https://x.dev.` */
const URL_TRAILING_PUNCTUATION = /[.,;:!?'"*_]+$/;

/**
 * A URL written out in prose, or in CommonMark's `<https://…>` autolink form.
 * A closing parenthesis stays only when the URL opened one, so a link in
 * brackets (like this https://x.dev) does not swallow the bracket.
 */
function matchBareUrl(
  text: string,
  index: number,
): { readonly url: string; readonly end: number } | undefined {
  if (text[index] === "<") {
    const angle = /^<(https?:\/\/[^\s<>]+)>/.exec(text.slice(index));
    if (angle === null) return undefined;
    return { url: angle[1] ?? "", end: index + (angle[0]?.length ?? 0) };
  }
  if (text[index] !== "h" || /[\w/]/.test(text[index - 1] ?? "")) return undefined;
  const found = /^https?:\/\/[^\s<>]+/.exec(text.slice(index));
  if (found === null) return undefined;
  let url = (found[0] ?? "").replace(URL_TRAILING_PUNCTUATION, "");
  while (url.endsWith(")") && count(url, "(") < count(url, ")")) {
    url = url.slice(0, -1).replace(URL_TRAILING_PUNCTUATION, "");
  }
  if (!/^https?:\/\/[^/]/.test(url)) return undefined;
  return { url, end: index + url.length };
}

function count(text: string, character: string): number {
  return text.split(character).length - 1;
}

/** Links read as links on every terminal: underlined, dimmed accent, and an OSC 8 target. */
function linkSegment(label: string, url: string): Segment {
  return {
    text: label,
    fg: THEME.link,
    underline: true,
    ...(url.length > 0 ? { link: url } : {}),
  };
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
      if (link.label.length > 0) {
        segments.push(linkSegment(link.label, link.url));
      }
      index = link.end;
      continue;
    }

    const bare = matchBareUrl(text, index);
    if (bare !== undefined) {
      flushPlain();
      segments.push(linkSegment(bare.url, bare.url));
      index = bare.end;
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

/** A list item: its nesting whitespace, an ordinal when it is ordered, and its text. */
const LIST_ITEM = /^(\s*)(?:[-*+]|(\d+[.)]))\s+(.*)$/;

/** Lines that open a new block, and so end a paragraph or a list item's continuation. */
const BLOCK_START = /^\s*(\||```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/;

/** A top-level list sits this far in from the prose edge, so its marker reads as structure. */
const LIST_INDENT = 2;

/**
 * Headings are ranked by weight and rule, never by hue and never by a glyph:
 * a marker in the rail column would read as a second speaker. The top level
 * is bold and underlined, the second bold, and anything deeper is bold
 * secondary text — still a heading, one step down the neutral ramp.
 */
function headingSegments(text: string, level: number, glyphs: GlyphSet): Segment[] {
  const fg = level <= 2 ? THEME.selected : THEME.secondary;
  return inlineSegments(text, fg, glyphs).map((segment) => ({
    ...segment,
    bold: true,
    ...(level <= 1 ? { underline: true } : {}),
  }));
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

    const fence = /^(\s*)```(.*)$/.exec(line);
    if (fence !== null) {
      // A fence opened inside a list item is indented with it; the body loses
      // that same indentation, as CommonMark reads it, so code starts on the
      // band's edge instead of floating inside it.
      const opener = (fence[1] ?? "").length;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
        const bodyLine = lines[index] ?? "";
        const leading = bodyLine.length - bodyLine.trimStart().length;
        body.push(bodyLine.slice(Math.min(opener, leading)));
        index += 1;
      }
      index += 1;
      items.push({
        kind: "fence",
        language: (fence[2] ?? "").trim().split(/\s+/)[0] ?? "",
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

    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      items.push({
        kind: "heading",
        level,
        segments: headingSegments(heading[2] ?? "", level, glyphs),
      });
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const quoted = [quote[1] ?? ""];
      index += 1;
      while (index < lines.length) {
        const next = /^\s*>\s?(.*)$/.exec(lines[index] ?? "");
        if (next === null || (next[1] ?? "").trim().length === 0) break;
        quoted.push((next[1] ?? "").trim());
        index += 1;
      }
      items.push({
        kind: "text",
        indent: 0,
        marker: { text: `${glyphs.blockquote} `, fg: THEME.border },
        repeatMarker: true,
        segments: inlineSegments(quoted.join(" "), THEME.secondary, glyphs),
      });
      continue;
    }

    const bullet = LIST_ITEM.exec(line);
    if (bullet !== null) {
      const depth = Math.floor(terminalCellWidth(bullet[1] ?? "") / 2);
      const ordinal = bullet[2];
      // Lazy continuation: the item runs on until a blank line or the start of
      // another block, the way CommonMark reads it.
      const body = [bullet[3] ?? ""];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (candidate.trim().length === 0 || BLOCK_START.test(candidate)) break;
        body.push(candidate.trim());
        index += 1;
      }
      items.push({
        kind: "text",
        indent: depth * 2 + LIST_INDENT,
        marker: { text: `${ordinal ?? glyphs.bullet} `, fg: THEME.muted },
        segments: inlineSegments(body.join(" "), THEME.selected, glyphs),
      });
      continue;
    }

    // A paragraph runs until a blank line or a line that starts a new item.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim().length === 0 || BLOCK_START.test(candidate)) {
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

/**
 * Borderless columns: a table is scanned, so its chrome is whitespace and a
 * single hairline under the header. Cells carry the same inline markdown as
 * prose. Body rows sit tight unless one of them wraps, at which point a blank
 * row between records is what keeps a two-line cell from reading as two rows.
 */
function tableRows(
  rows: readonly (readonly string[])[],
  width: number,
  key: string,
  gutterFor: () => readonly Segment[],
  glyphs: GlyphSet,
): RenderRow[] {
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const cells = rows.map((row, rowIndex) =>
    Array.from({ length: columns }, (_, column) => {
      const fg = rowIndex === 0 ? THEME.secondary : THEME.selected;
      const segments = inlineSegments(row[column] ?? "", fg, glyphs);
      return rowIndex === 0 ? segments.map((segment) => ({ ...segment, bold: true })) : segments;
    }),
  );
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(...cells.map((row) => terminalSegmentsWidth(row[column] ?? [])), 1),
  );
  const { sizes, gap } = tableColumnLayout(natural, width);

  const wrappedRows = cells.map((row) => row.map((cell, column) => wrap(cell, sizes[column] ?? 1)));
  const heights = wrappedRows.map((row) => Math.max(...row.map((cell) => cell.length), 1));
  const spaced = heights.slice(1).some((height) => height > 1);
  const tableWidth = Math.min(
    width,
    sizes.reduce((sum, size) => sum + size, 0) + gap * Math.max(0, columns - 1),
  );

  const rendered: RenderRow[] = [];
  for (let rowIndex = 0; rowIndex < wrappedRows.length; rowIndex += 1) {
    const wrapped = wrappedRows[rowIndex];
    if (wrapped === undefined) continue;
    const fg = rowIndex === 0 ? THEME.secondary : THEME.selected;
    for (let lineIndex = 0; lineIndex < (heights[rowIndex] ?? 1); lineIndex += 1) {
      const segments: Segment[] = [];
      wrapped.forEach((cell, column) => {
        segments.push(...padTableCell(cell, sizes[column] ?? 1, fg, lineIndex));
        if (column < columns - 1) segments.push({ text: " ".repeat(gap), fg });
      });
      rendered.push({
        key: `${key}:table:${String(rowIndex)}:${String(lineIndex)}`,
        gutter: gutterFor(),
        content: fitTerminalSegments(segments, width),
        contentWidth: width,
        meta: [],
      });
    }
    if (rowIndex === 0 && wrappedRows.length > 1) {
      rendered.push({
        key: `${key}:table:rule`,
        gutter: gutterFor(),
        content: [{ text: glyphs.divider.repeat(tableWidth), fg: THEME.border }],
        contentWidth: width,
        meta: [],
      });
    } else if (spaced && rowIndex < wrappedRows.length - 1) {
      rendered.push({
        key: `${key}:table:${String(rowIndex)}:gap`,
        gutter: gutterFor(),
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

// Blank, not the rail glyph — copy-pasting a reply must not drag a bar along.
function railCell(color: string): Segment {
  return { text: " ", fg: color };
}

function blankRow(key: string, contentWidth: number): RenderRow {
  return {
    key,
    gutter: [railCell(THEME.border), BLANK_CELL],
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
  /** Running text: never wider than `PROSE_MEASURE`, however wide the window. */
  readonly prose: number;
  /** Scanned output — tables, fences, expanded tool bodies — may use all of this. */
  readonly content: number;
  readonly metadata: number;
  /** Where the metadata strip ends: the prose measure plus the strip beside it. */
  readonly page: number;
}

/**
 * Full width is a property of the window, not a licence for the paragraph.
 * Prose stops at the measure, the metadata strip sits directly beside it so a
 * timestamp stays in reach of the line it annotates, and any surplus beyond
 * that is right-hand margin.
 */
function geometryFor(width: number): Geometry {
  const measure = measureFor(width);
  const prose = Math.min(PROSE_MEASURE, measure.prose);
  const content = measure.prose + measure.metadata;
  return {
    prose,
    content,
    metadata: measure.metadata,
    page: Math.min(content, prose + measure.metadata),
  };
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
  // Cached rows bake THEME colors at wrap time, so a theme switch must
  // invalidate them the same way a resize does.
  return `${String(width)}\0${String(getThemeRevision())}\0${glyphs.rail}\0${glyphs.divider}\0${glyphs.bullet}\0${glyphs.diamond}`;
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

/** Cells kept clear inside the right edge of a band, so text never touches its end. */
const BAND_PADDING = 1;

/**
 * Render a user turn as a neutral band exactly one measure wide, rail
 * included, so every wrapped row ends on the same column as the prose below.
 */
function userRows(
  block: Extract<Block, { kind: "user" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const meta: readonly Segment[] =
    block.at !== undefined && geometry.metadata > 0 ? [{ text: block.at, fg: THEME.muted }] : [];
  const lines = wrap(
    [{ text: block.text, fg: THEME.selected }],
    Math.max(1, geometry.prose - BAND_PADDING),
  );
  const bar: readonly Segment[] = [{ text: glyphs.bandBar, fg: THEME.primary }, BLANK_CELL];
  const panel = (
    key: string,
    content: readonly Segment[],
    rowMeta: readonly Segment[],
  ): RenderRow => ({
    key,
    gutter: bar,
    content,
    contentWidth: geometry.prose,
    meta: rowMeta,
    backgroundColor: THEME.surface,
    bandIncludesGutter: true,
  });
  // One row of panel above and below the text: the band reads as a surface
  // the message sits on, not a highlighter stroke through it.
  const rows: RenderRow[] = [panel(`${block.id}:top`, [], [])];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    rows.push(panel(`${block.id}:${String(index)}`, line, index === 0 ? meta : []));
  }
  rows.push(panel(`${block.id}:bottom`, [], []));
  return rows;
}

/**
 * Where an agent block's rows have got to. Rows are produced by folding prose
 * items into this state one at a time, so a streaming block can keep the state
 * reached at its last settled paragraph and resume from there, instead of
 * re-parsing and re-wrapping the whole answer on every reveal frame.
 */
interface ProseRowsState {
  rows: RenderRow[];
  /** The next row is the block's first, and carries the speaker marker. */
  first: boolean;
  /** A non-blank item has been emitted; blank items before it are dropped. */
  started: boolean;
  /** The last fence or table asked for a breathing row before the next item. */
  breatheBeforeNext: boolean;
  /** Key of a run of blank items waiting for the next non-blank item, so trailing blanks never land. */
  pendingBlankKey: string | undefined;
}

function initialProseRowsState(): ProseRowsState {
  return {
    rows: [],
    first: true,
    started: false,
    breatheBeforeNext: false,
    pendingBlankKey: undefined,
  };
}

function copyProseRowsState(state: ProseRowsState): ProseRowsState {
  return { ...state, rows: state.rows.slice() };
}

interface AgentRowStyle {
  readonly rail: Segment;
  readonly marker: Segment;
}

function agentRowStyle(block: Extract<Block, { kind: "agent" }>, glyphs: GlyphSet): AgentRowStyle {
  // Colour is state, not speaker: the rail is accent only while tokens land.
  const streaming = block.streaming === true;
  return {
    rail: railCell(streaming ? THEME.agent : THEME.border),
    marker: { text: glyphs.diamond, fg: streaming ? THEME.agent : THEME.secondary },
  };
}

/**
 * Fold prose items into rows. `offset` is the index of `items[0]` within the
 * whole block, so row keys match a parse of the full text however it was split.
 */
function appendProseItems(
  state: ProseRowsState,
  items: readonly ProseItem[],
  offset: number,
  blockId: string,
  style: AgentRowStyle,
  geometry: Geometry,
  glyphs: GlyphSet,
  streamingEpoch?: string,
): void {
  const rows = state.rows;
  const gutterFor = (): readonly Segment[] => {
    const gutter = [state.first ? style.marker : style.rail, BLANK_CELL];
    state.first = false;
    return gutter;
  };
  const lastIsBlank = (): boolean => {
    const last = rows[rows.length - 1];
    return last !== undefined && last.content.length === 0 && last.backgroundColor === undefined;
  };
  const blank = (key: string): RenderRow => ({
    key,
    gutter: gutterFor(),
    content: [],
    contentWidth: geometry.prose,
    meta: [],
  });
  // Headings, fences and tables are set off by one blank row on either side.
  // The model's own blank lines collapse into it, so spacing never doubles.
  const breathe = (key: string): void => {
    if (rows.length === 0 || lastIsBlank()) return;
    rows.push(blank(`${key}:breath`));
  };

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (item === undefined) continue;
    const key = `${blockId}:${String(offset + itemIndex)}`;
    if (item.kind === "blank") {
      // Models often open a text block with newlines after a tool call; a
      // leading blank row would strand the marker on an empty line.
      if (state.started && state.pendingBlankKey === undefined) {
        state.pendingBlankKey = key;
      }
      continue;
    }
    if (state.pendingBlankKey !== undefined) {
      if (!lastIsBlank()) rows.push(blank(state.pendingBlankKey));
      state.pendingBlankKey = undefined;
    }
    state.started = true;
    if (state.breatheBeforeNext) {
      breathe(key);
      state.breatheBeforeNext = false;
    }
    switch (item.kind) {
      case "rule":
        rows.push({
          key,
          gutter: gutterFor(),
          content: [{ text: glyphs.divider.repeat(geometry.prose), fg: THEME.border }],
          contentWidth: geometry.prose,
          meta: [],
        });
        break;
      case "heading": {
        breathe(key);
        const lines = wrap(item.segments, geometry.prose);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) continue;
          rows.push({
            key: `${key}:${String(lineIndex)}`,
            gutter: gutterFor(),
            content: line,
            contentWidth: geometry.prose,
            meta: [],
          });
        }
        break;
      }
      case "fence":
        breathe(key);
        appendRows(
          rows,
          streamingEpoch === undefined
            ? fenceRows(item.language, item.lines, geometry, key, gutterFor)
            : streamingFenceRows(
                item.language,
                item.lines,
                geometry,
                key,
                streamingEpoch,
                gutterFor,
              ),
        );
        state.breatheBeforeNext = true;
        break;
      case "table":
        breathe(key);
        appendRows(rows, tableRows(item.rows, geometry.content, key, gutterFor, glyphs));
        state.breatheBeforeNext = true;
        break;
      case "text": {
        const indent = item.indent;
        const markerWidth = item.marker === undefined ? 0 : terminalCellWidth(item.marker.text);
        const lines = wrap(item.segments, Math.max(1, geometry.prose - indent - markerWidth));
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) continue;
          const lead: Segment[] = [];
          if (indent > 0) lead.push({ text: " ".repeat(indent), fg: THEME.border });
          if (item.marker !== undefined) {
            // Wrapped rows hang under the text rather than the marker, so the
            // marker column stays a clean edge the eye can run down.
            lead.push(
              lineIndex === 0 || item.repeatMarker === true
                ? item.marker
                : { text: " ".repeat(markerWidth), fg: THEME.border },
            );
          }
          rows.push({
            key: `${key}:${String(lineIndex)}`,
            gutter: gutterFor(),
            content: [...lead, ...line],
            contentWidth: geometry.prose,
            meta: [],
          });
        }
      }
    }
  }
}

const FENCE_LINE = /^\s*```/;
const NEWLINE = 10;

interface StreamingProseCache {
  readonly blockId: string;
  readonly epoch: string;
  /** Where the open tail starts: just after the newline that ends the settled prefix. */
  readonly tailStart: number;
  /** The settled prefix, compared on resume so an edited answer starts over. */
  readonly prefix: string;
  readonly itemCount: number;
  readonly state: ProseRowsState;
}

let streamingProseCache: StreamingProseCache | undefined;

/** Drop what a streaming answer has settled, so the next frame renders it from scratch. */
export function forgetStreamingRows(): void {
  streamingProseCache = undefined;
  openFenceCache = undefined;
}

/**
 * The start of the last blank line outside a fence, scanning from `from`, or
 * -1. Every prose item stops at a blank line, so cutting the text just before
 * one and parsing the halves apart gives exactly the items of the whole. The
 * last line is still being written, so it is never a boundary.
 */
function lastSettledBoundary(markdown: string, from: number): number {
  let boundary = -1;
  let insideFence = false;
  let lineStart = from;
  for (;;) {
    const newline = markdown.indexOf("\n", lineStart);
    if (newline === -1) break;
    const line = markdown.slice(lineStart, newline);
    if (FENCE_LINE.test(line)) {
      insideFence = !insideFence;
    } else if (!insideFence && lineStart > from && line.trim().length === 0) {
      boundary = lineStart;
    }
    lineStart = newline + 1;
  }
  return boundary;
}

/**
 * Rows for an answer that is still streaming, at the cost of its open tail
 * rather than the whole answer. Everything before the last blank line outside
 * a fence is settled: its rows and the fold state after them are kept, and
 * each frame resumes from there, parsing and wrapping only what came after.
 */
function streamingAgentRows(
  block: Extract<Block, { kind: "agent" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
  style: AgentRowStyle,
): RenderRow[] {
  const markdown = block.markdown;
  const epoch = `${wrapEpoch(geometry.page, glyphs)}\0${String(geometry.prose)}\0${String(geometry.content)}`;
  const previous = streamingProseCache;
  let settled: StreamingProseCache =
    previous !== undefined &&
    previous.blockId === block.id &&
    previous.epoch === epoch &&
    markdown.length >= previous.tailStart &&
    (previous.tailStart === 0 || markdown.charCodeAt(previous.tailStart - 1) === NEWLINE) &&
    markdown.startsWith(previous.prefix)
      ? previous
      : {
          blockId: block.id,
          epoch,
          tailStart: 0,
          prefix: "",
          itemCount: 0,
          state: initialProseRowsState(),
        };

  const boundary = lastSettledBoundary(markdown, settled.tailStart);
  if (boundary > settled.tailStart) {
    // The segment ends before the newline that precedes the blank line, so the
    // blank line itself opens the next segment, as it would in one parse.
    const items = parseProse(markdown.slice(settled.tailStart, boundary - 1), glyphs);
    const state = copyProseRowsState(settled.state);
    appendProseItems(state, items, settled.itemCount, block.id, style, geometry, glyphs, epoch);
    settled = {
      blockId: block.id,
      epoch,
      tailStart: boundary,
      prefix: markdown.slice(0, boundary),
      itemCount: settled.itemCount + items.length,
      state,
    };
  }
  streamingProseCache = settled;

  const state = copyProseRowsState(settled.state);
  appendProseItems(
    state,
    parseProse(markdown.slice(settled.tailStart), glyphs),
    settled.itemCount,
    block.id,
    style,
    geometry,
    glyphs,
    epoch,
  );
  return state.rows;
}

function agentRows(
  block: Extract<Block, { kind: "agent" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const style = agentRowStyle(block, glyphs);
  if (block.streaming === true) {
    return streamingAgentRows(block, geometry, glyphs, style);
  }
  const state = initialProseRowsState();
  appendProseItems(state, parseProse(block.markdown, glyphs), 0, block.id, style, geometry, glyphs);
  return state.rows;
}

interface FenceLayout {
  readonly width: number;
  readonly inner: number;
}

function fenceLayout(longest: number, geometry: Geometry): FenceLayout {
  const width = Math.min(geometry.content, Math.max(geometry.prose, longest + BAND_PADDING));
  return { width, inner: Math.max(1, width - BAND_PADDING) };
}

function fenceSurface(
  rowKey: string,
  content: readonly Segment[],
  width: number,
  gutter: readonly Segment[],
): RenderRow {
  return {
    key: rowKey,
    gutter,
    content,
    contentWidth: width,
    meta: [],
    backgroundColor: THEME.surfaceStrong,
    bandIncludesGutter: true,
  };
}

function fenceLabelRow(
  language: string,
  layout: FenceLayout,
  key: string,
  gutter: readonly Segment[],
): RenderRow {
  const label = sliceTerminalCells(language.trim().split(/\s+/)[0] ?? "", layout.inner);
  const labelOffset = Math.max(0, layout.width - BAND_PADDING - terminalCellWidth(label));
  return fenceSurface(
    `${key}:fence:top`,
    label.length === 0
      ? []
      : [
          { text: " ".repeat(labelOffset), fg: THEME.muted },
          { text: label, fg: THEME.muted },
        ],
    layout.width,
    gutter,
  );
}

/**
 * A fence is a painted surface one step up from the canvas. The band starts
 * under the rail, so its two gutter cells are the inner left padding and the
 * code lines up with the prose column. A padding row above carries the
 * language, muted and flush right; a padding row below closes the band. It is
 * at least the prose measure wide, so it squares with the paragraph around it,
 * and grows toward the full content width only for longer lines.
 */
function fenceRows(
  language: string,
  lines: readonly string[],
  geometry: Geometry,
  key: string,
  gutterFor: () => readonly Segment[],
): RenderRow[] {
  const painted = highlightFenceLines(language, lines);
  const layout = fenceLayout(
    Math.max(0, ...lines.map((line) => terminalCellWidth(line))),
    geometry,
  );
  const rows: RenderRow[] = [fenceLabelRow(language, layout, key, gutterFor())];
  for (let lineIndex = 0; lineIndex < painted.length; lineIndex += 1) {
    const spans = painted[lineIndex];
    if (spans === undefined) continue;
    rows.push(
      fenceSurface(
        `${key}:${String(lineIndex)}`,
        fitTerminalSegments([...spans], layout.inner),
        layout.width,
        gutterFor(),
      ),
    );
  }
  rows.push(fenceSurface(`${key}:fence:bottom`, [], layout.width, gutterFor()));
  return rows;
}

/**
 * The fence a streaming answer is writing into. It has no blank line outside
 * itself to settle at, so without this every reveal frame would re-highlight
 * and re-fit its whole body. Settled lines keep their highlight and their row;
 * rows are rebuilt only when a longer line widens the band.
 */
interface OpenFenceCache {
  readonly key: string;
  readonly epoch: string;
  readonly highlight: FenceHighlight;
  /** Widest of the first `measuredLines` lines, in cells. */
  readonly longestSettled: number;
  readonly measuredLines: number;
  readonly layout: FenceLayout;
  /** Rows for the settled lines, laid out at `layout`, all spans from `highlight`. */
  readonly settledRows: readonly RenderRow[];
  /** The settled spans the rows were built from, so a diff reclassification rebuilds them. */
  readonly settledSpans: readonly (readonly SyntaxSpan[])[];
}

let openFenceCache: OpenFenceCache | undefined;

function streamingFenceRows(
  language: string,
  lines: readonly string[],
  geometry: Geometry,
  key: string,
  epoch: string,
  gutterFor: () => readonly Segment[],
): RenderRow[] {
  const previous =
    openFenceCache !== undefined && openFenceCache.key === key && openFenceCache.epoch === epoch
      ? openFenceCache
      : undefined;
  const highlight = continueFenceHighlight(previous?.highlight, language, lines);
  const settledCount = Math.max(0, lines.length - 1);

  const resumed =
    previous !== undefined &&
    previous.highlight.language === language &&
    lines.length > previous.measuredLines;
  let longestSettled = resumed ? previous.longestSettled : 0;
  for (let index = resumed ? previous.measuredLines : 0; index < settledCount; index += 1) {
    longestSettled = Math.max(longestSettled, terminalCellWidth(lines[index] ?? ""));
  }
  const last = lines.length > 0 ? terminalCellWidth(lines[lines.length - 1] ?? "") : 0;
  const layout = fenceLayout(Math.max(longestSettled, last), geometry);

  const top = fenceLabelRow(language, layout, key, gutterFor());
  const rail = gutterFor();
  const settledSpans = highlight.spans.slice(0, settledCount);
  const reuse =
    resumed &&
    previous.layout.width === layout.width &&
    previous.layout.inner === layout.inner &&
    previous.settledRows.length <= settledCount &&
    previous.settledSpans.every((spans, index) => spans === settledSpans[index]);
  const settledRows = reuse ? previous.settledRows.slice() : [];
  for (let index = settledRows.length; index < settledCount; index += 1) {
    settledRows.push(
      fenceSurface(
        `${key}:${String(index)}`,
        fitTerminalSegments([...(settledSpans[index] ?? [])], layout.inner),
        layout.width,
        rail,
      ),
    );
  }
  openFenceCache = {
    key,
    epoch,
    highlight,
    longestSettled,
    measuredLines: settledCount,
    layout,
    settledRows,
    settledSpans,
  };

  const rows: RenderRow[] = [top, ...settledRows];
  if (lines.length > 0) {
    rows.push(
      fenceSurface(
        `${key}:${String(lines.length - 1)}`,
        fitTerminalSegments([...(highlight.spans[lines.length - 1] ?? [])], layout.inner),
        layout.width,
        rail,
      ),
    );
  }
  rows.push(fenceSurface(`${key}:fence:bottom`, [], layout.width, rail));
  return rows;
}

function reasoningRows(
  block: Extract<Block, { kind: "reasoning" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const rail = railCell(THEME.border);
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

/**
 * A settled receipt: what it did and what came back, and nothing else.
 *
 * A successful receipt is exactly one row. `budget` is the cells it may use;
 * the arguments are the only part that gives way, cropped with an ellipsis, so
 * the app on the left and the outcome on the right always survive.
 */
function receiptSegments(block: ToolReceiptBlock, glyphs: GlyphSet, budget: number): Segment[] {
  const args = block.args?.trim().replace(/\s+/g, " ");
  const summary = block.summary.trim();
  if (block.status === "ok") {
    const head: Segment[] = [];
    if (block.app.length > 0) {
      head.push({ text: block.app, fg: THEME.muted });
    }
    const tail: Segment[] = [];
    if (summary.length > 0) {
      tail.push({ text: `  ${summary}`, fg: THEME.muted });
    }
    if (block.classifiedRisk !== undefined) {
      tail.push({ text: ` ${glyphs.bullet} ${block.classifiedRisk}`, fg: THEME.muted });
    }
    if (args === undefined || args.length === 0) {
      return [...head, ...tail];
    }
    const argSegments = highlightedArgs(args, THEME.secondary, block.app);
    const room = budget - terminalSegmentsWidth(head) - terminalSegmentsWidth(tail);
    if (terminalSegmentsWidth(argSegments) <= room) {
      return [...head, ...argSegments, ...tail];
    }
    if (room <= 4) {
      return [...head, ...tail];
    }
    const cropped = fitTerminalSegments(argSegments, room - 1);
    return [...head, ...cropped, { text: "…", fg: THEME.muted }, ...tail];
  }
  if (block.status === "denied") {
    const segments: Segment[] = [{ text: block.app, fg: THEME.warning }];
    if (args !== undefined && args.length > 0) {
      const room = budget - terminalCellWidth(block.app) - terminalCellWidth("  denied") - 2;
      const shown =
        terminalCellWidth(args) + 2 <= room
          ? args
          : `${sliceTerminalCells(args, Math.max(0, room - 3))}…`;
      if (room > 4) {
        segments.push({ text: `  ${shown}`, fg: THEME.muted });
      }
    }
    segments.push({ text: "  denied", fg: THEME.warning });
    return segments;
  }
  // Failure keeps a colour and states the reason inline. A short reason stays
  // on the same row as the app; a long one wraps rather than cropping.
  const tone = THEME.error;
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

/** Pack short receipts; wrap any tool call that needs more than one row. */
function receiptRows(
  blocks: readonly ToolReceiptBlock[],
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const rail = railCell(THEME.border);
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
    const segments = receiptSegments(block, glyphs, geometry.prose);
    const needsOwnRows =
      block.status !== "ok" ||
      block.expanded === true ||
      segments.some((segment) => segment.text.includes("\n")) ||
      terminalSegmentsWidth(segments) > geometry.prose;

    if (needsOwnRows) {
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
  // Only a warning or an error earns a gutter mark. System and command output
  // leaves the gutter empty, so it can never be read as the agent speaking,
  // whose marker sits in the same cell.
  const tone =
    block.tone === "error"
      ? THEME.error
      : block.tone === "warn"
        ? THEME.warning
        : block.tone === "receipt"
          ? THEME.muted
          : THEME.secondary;
  const glyph =
    block.tone === "error" ? glyphs.error : block.tone === "warn" ? glyphs.warn : undefined;
  const lines = wrap([{ text: block.text, fg: tone }], geometry.prose);
  const rows: RenderRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const gutterMark =
      index === 0 && glyph !== undefined
        ? { text: glyph, fg: tone }
        : glyph !== undefined
          ? railCell(THEME.border)
          : BLANK_CELL;
    rows.push({
      key: `${block.id}:${String(index)}`,
      gutter: [gutterMark, BLANK_CELL],
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
      gutter: [railCell(THEME.border), BLANK_CELL],
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
  const rail = railCell(railColor);
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
 * The width the transcript's rows span: the whole terminal. Prose and its
 * metadata strip stop at the measure (see `geometryFor`); scanned content may
 * run on to the right margin.
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

  const geometry = geometryFor(width);

  const rows: RenderRow[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (block === undefined) break;
    if (needsBreathingRow(block, blocks[index - 1])) {
      rows.push(blankRow(`gap:${block.id}`, geometry.prose));
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

interface LinkHover {
  readonly hovered: string | undefined;
  readonly setHovered: (target: string | undefined) => void;
}

/**
 * Shared across rows so every row of a wrapped link underlines together, keyed
 * by target because a wrapped label becomes one segment per row.
 */
const LinkHoverContext = createContext<LinkHover>({
  hovered: undefined,
  setHovered: () => undefined,
});

/**
 * Opens the link under a click and reports the one under the pointer. The
 * terminal cannot do either itself: mouse capture keeps clicks from reaching it,
 * and OpenTUI drops OSC 8 targets on terminals it cannot confirm support them. A
 * press and release on different cells is a selection drag, not a click.
 */
function useLinkPointer(segments: readonly Segment[]): {
  readonly onMouseDown?: (event: OTMouseEvent) => void;
  readonly onMouseUp?: (event: OTMouseEvent) => void;
  readonly onMouseMove?: (event: OTMouseEvent) => void;
  readonly onMouseOut?: (event: OTMouseEvent) => void;
} {
  const { setHovered } = useContext(LinkHoverContext);
  const pressedAt = useRef<{ readonly x: number; readonly y: number } | undefined>(undefined);
  if (!segments.some((segment) => segment.link !== undefined)) {
    return {};
  }
  const linkUnder = (event: OTMouseEvent): string | undefined => {
    const origin = event.currentTarget;
    return origin === null ? undefined : linkAtColumn(segments, event.x - origin.x);
  };
  return {
    onMouseDown: (event) => {
      pressedAt.current = { x: event.x, y: event.y };
    },
    onMouseUp: (event) => {
      const pressed = pressedAt.current;
      pressedAt.current = undefined;
      if (pressed === undefined || pressed.x !== event.x || pressed.y !== event.y) {
        return;
      }
      const target = linkUnder(event);
      if (target !== undefined) {
        openLink(target);
      }
    },
    onMouseMove: (event) => {
      setHovered(linkUnder(event));
    },
    onMouseOut: () => {
      setHovered(undefined);
    },
  };
}

function Spans({ segments }: { segments: readonly Segment[] }): ReactNode {
  const linkPointer = useLinkPointer(segments);
  const { hovered } = useContext(LinkHoverContext);
  if (segments.length === 0) return null;
  return (
    <text
      style={{ wrapMode: "none", truncate: true }}
      {...linkPointer}
    >
      {segments.map((segment, index) => {
        // Links are always underlined, so hovering one lifts it to the full accent instead.
        const isHovered = hovered !== undefined && segment.link === hovered;
        const attributes = segmentAttributes(segment);
        const key = `${String(index)}:${segment.text}`;
        const style = {
          fg: isHovered ? THEME.primary : segment.fg,
          // OpenTUI text nodes honour `attributes`, not `bold`/`italic` booleans.
          ...(attributes === 0 ? {} : { attributes }),
        };
        if (segment.link !== undefined) {
          return (
            <a
              key={key}
              href={segment.link}
              style={style}
            >
              {segment.text}
            </a>
          );
        }
        return (
          <span
            key={key}
            style={style}
          >
            {segment.text}
          </span>
        );
      })}
    </text>
  );
}

function Row({ row, width }: { row: RenderRow; width: number }): ReactNode {
  const band = row.backgroundColor === undefined ? {} : { backgroundColor: row.backgroundColor };
  const strip = Math.max(0, geometryFor(width).page - row.contentWidth);
  return (
    <box
      style={{
        width,
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
      }}
    >
      <box
        style={{ width: GUTTER, flexShrink: 0, ...(row.bandIncludesGutter === true ? band : {}) }}
      >
        <Spans segments={row.gutter} />
      </box>
      <box style={{ width: row.contentWidth, flexShrink: 0, ...band }}>
        <Spans segments={row.content} />
      </box>
      <box
        style={{ width: strip, flexShrink: 0, flexDirection: "row", justifyContent: "flex-end" }}
      >
        <Spans segments={row.meta} />
      </box>
      <box style={{ flexGrow: 1 }} />
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
  /** Called when the view reaches the live edge, so the "new below" hint can clear on scroll. */
  readonly onReachedBottom?: () => void;
  /**
   * Rows the transcript may paint. Defaults to `viewport.height` for standalone
   * tests; the shell passes the leftover after chrome, live band, and composer.
   */
  readonly visibleCount?: number;
}

export interface TranscriptHandle {
  scrollBy(delta: number, unit?: "line" | "page" | "end"): boolean;
  /**
   * Rows the live edge currently sits on. The shell tracks this instead of
   * block count, because a streaming answer grows one block in place — a block
   * diff stays zero for the whole answer and the "new below" hint never fires.
   */
  rowCount(): number;
}

const TranscriptView = forwardRef<TranscriptHandle, TranscriptProps>(function Transcript(
  { blocks, viewport, focus, newBelow, followLive = true, visibleCount, onReachedBottom },
  ref,
): ReactNode {
  // Deriving rows re-parses every block's markdown, tables and fences. The
  // shell re-renders on each streaming delta and each keystroke, so without
  // this the cost of a frame grows with the length of the whole conversation
  // rather than with what changed. The rows bake colours, so a theme switch
  // recomputes them.
  const themeRevision = useThemeRevision();
  const rows = useMemo(
    () => transcriptRows(blocks, viewport),
    [blocks, viewport.width, themeRevision],
  );
  const page = pageWidth(viewport);
  const windowHeight =
    visibleCount === undefined ? Math.max(1, viewport.height) : Math.max(0, visibleCount);
  const [, setScrollVersion] = useState(0);
  const [hoveredLink, setHoveredLink] = useState<string | undefined>(undefined);
  const linkHover = useMemo(
    () => ({ hovered: hoveredLink, setHovered: setHoveredLink }),
    [hoveredLink],
  );
  const renderer = useRenderer();
  const isHoveringLink = hoveredLink !== undefined;
  useEffect(() => {
    if (!isHoveringLink) {
      return;
    }
    renderer.setMousePointer("pointer");
    return () => {
      renderer.setMousePointer("default");
    };
  }, [isHoveringLink, renderer]);
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

  useEffect(() => {
    if (offset === 0) onReachedBottom?.();
  }, [offset, onReachedBottom]);

  useImperativeHandle(ref, () => ({
    scrollBy(delta: number, unit: "line" | "page" | "end" = "line"): boolean {
      const currentRows = rowsRef.current;
      const next = applyScrollDelta(
        scrollFromBottomRef.current,
        currentRows.length,
        heightRef.current,
        delta,
        unit,
      );
      if (next === scrollFromBottomRef.current) return next === 0;
      scrollFromBottomRef.current = next;
      setScrollVersion((version) => version + 1);
      return next === 0;
    },
    rowCount(): number {
      return rowsRef.current.length;
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
      <LinkHoverContext.Provider value={linkHover}>
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
      </LinkHoverContext.Provider>

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
