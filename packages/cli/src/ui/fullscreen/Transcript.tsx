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
import { spaceReasoningSections } from "../../presentation/format-utils";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { parseMarkdown, type MarkdownBlock } from "../markdown/parse";
import { markdownRoleColor, type MarkdownSpan } from "../markdown/spans";
import { layoutTable } from "../markdown/table";
import { stoppedHeading } from "../models/interrupt";
import { receiptParts } from "../models/receipt";
import { reportLines, type ReportSegment } from "../report-layout";
import { formatPreciseDuration } from "../text/format";
import { PROSE_MEASURE } from "../text/measure";
import { roleStyle, type RoleSegment, type TextRole } from "../text/roles";
import {
  continueFenceHighlight,
  highlightCodeLine,
  highlightFenceLines,
  pathFromFileArgsPreview,
  sourceLanguageFromPath,
  type FenceHighlight,
  type SyntaxSpan,
} from "../text/syntax-spans";
import {
  fitTerminalSegments,
  sliceTerminalCells,
  terminalCellWidth,
  terminalSegmentsWidth,
} from "../text/terminal-cells";
import { wrapStyledSpans } from "../text/wrap";
import { getThemeRevision, THEME } from "../theme";
import { foldedThoughtLine, thoughtLabel } from "../turn-thought";
import { linkAtColumn, openLink } from "./open-link";
import { useThemeRevision } from "./theme-revision";
import { applyScrollDelta, clampScrollFromBottom, windowTranscriptRows } from "./transcript-window";
import {
  measureFor,
  type Block,
  type Focus,
  type StoppedBlock,
  type ToolReceiptBlock,
  type Viewport,
} from "./types";

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

function wrap(segments: readonly Segment[], measure: number): Segment[][] {
  return wrapStyledSpans(segments, measure, sameInlineStyle);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

// ─── Markdown ────────────────────────────────────────────────────────────────

/**
 * OpenTUI ships a `<markdown>` renderable, and it is not usable here. It draws
 * nothing at all for a paragraph unless either a tree-sitter client is attached
 * or `streaming` is left permanently true, it hardcodes its own list bullets and
 * blockquote bars where this product is required to route every glyph through
 * `getGlyphs()` so the ASCII fallback works, and it renders one subtree at one
 * measure — which forfeits exactly the prose/table measure split above. So the
 * shared parser in `ui/markdown` produces blocks and styled spans, and this
 * file only lays them out.
 */
type ProseItem = MarkdownBlock;

/** Paint parsed spans with the theme: the role becomes a colour, the marks and link carry over. */
function segmentsOf(spans: readonly MarkdownSpan[]): Segment[] {
  return spans.map((span) => ({
    text: span.text,
    fg: markdownRoleColor(span.role),
    ...(span.bold === true ? { bold: true } : {}),
    ...(span.italic === true ? { italic: true } : {}),
    ...(span.underline === true ? { underline: true } : {}),
    ...(span.strikethrough === true ? { strikethrough: true } : {}),
    ...(span.link === undefined ? {} : { link: span.link }),
  }));
}

function parseProse(markdown: string, glyphs: GlyphSet): ProseItem[] {
  return parseMarkdown(markdown, { glyphs });
}

function tableRows(
  item: Extract<ProseItem, { kind: "table" }>,
  width: number,
  key: string,
  gutterFor: () => readonly Segment[],
  glyphs: GlyphSet,
): RenderRow[] {
  const layout = layoutTable(item.rows, item.align, width);
  const linesInRow = new Map<number, number>();
  return layout.lines.map((line) => {
    let rowKey: string;
    let content: readonly Segment[];
    if (line.kind === "cells") {
      const lineIndex = linesInRow.get(line.row) ?? 0;
      linesInRow.set(line.row, lineIndex + 1);
      rowKey = `${key}:table:${String(line.row)}:${String(lineIndex)}`;
      content = fitTerminalSegments(segmentsOf(line.spans), width);
    } else if (line.kind === "rule") {
      rowKey = `${key}:table:rule`;
      content = [{ text: glyphs.divider.repeat(layout.width), fg: THEME.border }];
    } else {
      rowKey = `${key}:table:${String(line.row)}:gap`;
      content = [];
    }
    return { key: rowKey, gutter: gutterFor(), content, contentWidth: width, meta: [] };
  });
}

// ─── Blocks to rows ──────────────────────────────────────────────────────────

/** The spacer cell after the gutter mark, in the current theme. */
function blankCell(): Segment {
  return { text: " ", fg: THEME.border };
}

// Blank, not the rail glyph — copy-pasting a reply must not drag a bar along.
function railCell(color: string): Segment {
  return { text: " ", fg: color };
}

function blankRow(key: string, contentWidth: number): RenderRow {
  return {
    key,
    gutter: [railCell(THEME.border), blankCell()],
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
  // Two command answers in a row are two answers, not one list.
  if (block.kind === "report") return true;
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

/** Release terminal rows and streamed prefixes when their owning view goes away. */
function releaseTranscriptCaches(): void {
  blockRowsCache = new WeakMap();
  runRowsCache = new WeakMap();
  lastTranscriptBlocks = undefined;
  lastTranscriptRows = undefined;
  lastTranscriptEpoch = undefined;
  wrapCacheEpoch = undefined;
  forgetStreamingRows();
}

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
    case "report":
      return reportRows(block, geometry, glyphs);
    case "divider":
      return dividerRows(block, geometry, glyphs);
    case "stopped":
      return stoppedRows(block, geometry, glyphs);
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
  const bar: readonly Segment[] = [{ text: glyphs.bandBar, fg: THEME.primary }, blankCell()];
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
    const gutter = [state.first ? style.marker : style.rail, blankCell()];
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
        const lines = wrap(segmentsOf(item.spans), geometry.prose);
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
        appendRows(rows, tableRows(item, geometry.content, key, gutterFor, glyphs));
        state.breatheBeforeNext = true;
        break;
      case "text": {
        const indent = item.indent;
        const markerWidth = item.marker === undefined ? 0 : terminalCellWidth(item.marker.text);
        const marker = item.marker === undefined ? undefined : segmentsOf([item.marker])[0];
        const lines = wrap(
          segmentsOf(item.spans),
          Math.max(1, geometry.prose - indent - markerWidth),
        );
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) continue;
          const lead: Segment[] = [];
          if (indent > 0) lead.push({ text: " ".repeat(indent), fg: THEME.border });
          if (marker !== undefined) {
            // Wrapped rows hang under the text rather than the marker, so the
            // marker column stays a clean edge the eye can run down.
            lead.push(
              lineIndex === 0 || item.repeatMarker === true
                ? marker
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

/**
 * An accent block at the reveal point, so the eye finds where the answer is
 * growing. It sits in the cell after the last text and is drawn only when that
 * cell exists inside the row's width, so it never wraps a line or moves text.
 * It holds still rather than blinking: the reveal only repaints while text is
 * arriving, and a blink would need a timer of its own for a cell that already
 * moves with every word.
 */
function withStreamCursor(rows: RenderRow[], glyphs: GlyphSet): RenderRow[] {
  const last = rows[rows.length - 1];
  if (last === undefined) return rows;
  if (terminalSegmentsWidth(last.content) + 1 > last.contentWidth) return rows;
  const cursor: Segment = { text: glyphs.streamCursor, fg: THEME.agent };
  const withCursor = rows.slice();
  withCursor[withCursor.length - 1] = { ...last, content: [...last.content, cursor] };
  return withCursor;
}

function agentRows(
  block: Extract<Block, { kind: "agent" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const style = agentRowStyle(block, glyphs);
  if (block.streaming === true) {
    return withStreamCursor(streamingAgentRows(block, geometry, glyphs, style), glyphs);
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

/** While the model thinks, only its newest lines show, so reasoning cannot push the conversation away. */
export const LIVE_REASONING_LINES = 3;

/**
 * Reasoning is the model's scratchpad, never its answer: italic, muted, behind
 * a thin rule, and at a narrower measure. It has three states.
 *
 * - Live: an italic "thinking" label with the elapsed time, and the newest
 *   lines only.
 * - Folded (settled): one line per turn, `› thought for 4.1s · ctrl+r to read`.
 * - Opened with ctrl+r: the full text under `╷ thought for 4.1s`, with the key
 *   that folds it again.
 */
function reasoningRows(
  block: Extract<Block, { kind: "reasoning" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const rail = railCell(THEME.border);
  const gutter: readonly Segment[] = [rail, blankCell()];
  const indent: Segment = { text: " ".repeat(REASONING_INDENT), fg: THEME.border };
  const row = (
    key: string,
    content: readonly Segment[],
    meta: readonly Segment[] = [],
  ): RenderRow => ({
    key,
    gutter,
    content,
    contentWidth: geometry.prose,
    meta,
  });
  const separator = ` ${glyphs.bullet} `;

  if (block.collapsed) {
    return [
      row(`${block.id}:0`, [
        indent,
        {
          text: foldedThoughtLine(block, block.readable !== false, glyphs.folded, separator),
          fg: THEME.muted,
        },
      ]),
    ];
  }

  // Subordinate by geometry, not by a new hue: narrower, indented, never bold.
  const measure = Math.max(24, Math.floor(geometry.prose * REASONING_MEASURE_RATIO));
  const ruled: Segment = { text: `${glyphs.railDeep} `, fg: THEME.border };
  const text = spaceReasoningSections(block.text);
  const wrapped = wrap([{ text, fg: THEME.muted, italic: true }], measure - REASONING_INDENT - 2);
  const bodyRows = (lines: readonly (readonly Segment[])[], keyOffset: number): RenderRow[] =>
    lines.map((line, index) =>
      row(`${block.id}:${String(keyOffset + index)}`, [indent, ruled, ...line]),
    );

  // The live zone right below says "thinking" with the elapsed time, so the
  // lines carry no label of their own; a second one would stack the word twice.
  if (block.live === true) {
    const newest = text.trim().length === 0 ? [] : wrapped.slice(-LIVE_REASONING_LINES);
    return bodyRows(newest, Math.max(0, wrapped.length - newest.length));
  }

  return [
    row(`${block.id}:label`, [
      indent,
      { text: `${glyphs.unfolded} ${thoughtLabel(block)}`, fg: THEME.secondary },
    ]),
    ...bodyRows(wrapped, 0),
    row(`${block.id}:fold`, [
      indent,
      { text: `ctrl+r to fold${separator}again for the previous block`, fg: THEME.muted },
    ]),
  ];
}

function highlightedArgs(args: string, fallbackFg: string, app: string): Segment[] {
  const path = pathFromFileArgsPreview(args);
  const language = path === undefined ? undefined : sourceLanguageFromPath(path);
  if (language === undefined && !isFileMutationTool(app)) {
    return [{ text: `  ${args}`, fg: fallbackFg }];
  }
  return [{ text: "  ", fg: fallbackFg }, ...highlightCodeLine(args)];
}

function partSegment(part: RoleSegment): Segment {
  const style = roleStyle(part.role);
  return style.bold === true
    ? { text: part.text, fg: style.fg, bold: true }
    : { text: part.text, fg: style.fg };
}

/**
 * A settled receipt: what it did and what came back, and nothing else.
 *
 * The words are the shared receipt parts every renderer prints; this adds only the layout.
 * A successful or declined receipt is exactly one row. `budget` is the cells it may use; the
 * arguments are the only part that gives way, cropped with an ellipsis, so the app on the left
 * and the outcome on the right always survive. A failure wraps instead, because its reason is
 * the part worth reading.
 */
function receiptSegments(block: ToolReceiptBlock, glyphs: GlyphSet, budget: number): Segment[] {
  const parts = receiptParts(block, glyphs);
  const argsIndex = parts.findIndex((candidate) => candidate.kind === "args");
  const argsPart = parts[argsIndex];
  if (block.status === "failed" || argsPart === undefined) {
    return parts.map(partSegment);
  }
  const head = parts.slice(0, argsIndex).map(partSegment);
  const tail = parts.slice(argsIndex + 1).map(partSegment);
  const argSegments =
    block.status === "ok"
      ? highlightedArgs(argsPart.text.trimStart(), roleStyle(argsPart.role).fg, block.app)
      : [partSegment(argsPart)];
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
      gutter: [rail, blankCell()],
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
          ? [{ text: formatPreciseDuration(block.durationMs), fg: THEME.muted }]
          : [];
      if (segments.some((segment) => segment.text.trim().length > 0)) {
        const lines = wrap(segments, geometry.prose);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          if (line === undefined) continue;
          rows.push({
            key: `${block.id}:${String(lineIndex)}`,
            gutter: [lineIndex === 0 && block.status !== "ok" ? marker : rail, blankCell()],
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
            gutter: [rail, blankCell()],
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
          : blankCell();
    rows.push({
      key: `${block.id}:${String(index)}`,
      gutter: [gutterMark, blankCell()],
      content: line,
      contentWidth: geometry.prose,
      meta: [],
    });
  }
  return rows;
}

function reportColor(role: TextRole): Segment {
  const style = roleStyle(role);
  return style.bold === true ? { text: "", fg: style.fg, bold: true } : { text: "", fg: style.fg };
}

/**
 * A command's answer in jazz's own voice: an empty gutter (the agent's marker
 * never appears), the command's name in the label column, and every other row
 * hanging under the value column. A row wider than the measure wraps under its
 * own column rather than back to the label.
 */
function reportRows(
  block: Extract<Block, { kind: "report" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const rows: RenderRow[] = [];
  const paint = (segments: readonly ReportSegment[]): Segment[] =>
    segments.map((segment) => ({ ...reportColor(segment.role), text: segment.text }));
  reportLines(block.report, glyphs).forEach((line, lineIndex) => {
    // The prefix (the label, a key, a marker and name) sets where a wrapped value
    // continues, so a long value hangs under its own column rather than the label.
    const indent: Segment = { text: " ".repeat(line.indent), fg: THEME.muted };
    const prefix = [
      ...(line.indent > 0 ? [indent] : []),
      ...paint(line.segments.slice(0, line.lead)),
    ];
    const hang = terminalSegmentsWidth(prefix);
    const rest = paint(line.segments.slice(line.lead));
    const wrapped = rest.length === 0 ? [[]] : wrap(rest, Math.max(1, geometry.prose - hang));
    const continuation: Segment = { text: " ".repeat(hang), fg: THEME.muted };
    wrapped.forEach((content, wrapIndex) => {
      rows.push({
        key: `${block.id}:${String(lineIndex)}:${String(wrapIndex)}`,
        gutter: [blankCell(), blankCell()],
        content: [...(wrapIndex === 0 ? prefix : [continuation]), ...content],
        contentWidth: geometry.prose,
        meta: [],
      });
    });
  });
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
      gutter: [railCell(THEME.border), blankCell()],
      content: [
        { text: label, fg: THEME.muted },
        { text: rule, fg: THEME.border },
      ],
      contentWidth: geometry.content,
      meta: [],
    },
  ];
}

/** Label column for the stopped summary: `done` and `not done` share one measure. */
const STOPPED_LABEL = "not done  ";

/**
 * A stopped turn: a quiet rule that says who stopped it and when, then what finished and
 * what did not, one per row. Never the error colour: stopping is something a person chose.
 */
function stoppedRows(block: StoppedBlock, geometry: Geometry, glyphs: GlyphSet): RenderRow[] {
  const heading = `${stoppedHeading(block.elapsedMs)} `;
  const rule = glyphs.divider.repeat(
    Math.max(0, Math.min(geometry.prose, geometry.content) - terminalCellWidth(heading)),
  );
  const rows: RenderRow[] = [
    {
      key: `${block.id}:rule`,
      gutter: [railCell(THEME.border), blankCell()],
      content: [
        { text: heading, fg: THEME.muted },
        { text: rule, fg: THEME.border },
      ],
      contentWidth: geometry.content,
      meta: [],
    },
  ];
  const listed = (label: string, items: readonly string[]): void => {
    items.forEach((item, index) => {
      const content: Segment[] = [
        { text: (index === 0 ? label : "").padEnd(STOPPED_LABEL.length), fg: THEME.muted },
        ...fitTerminalSegments(
          [{ text: item, fg: THEME.selected }],
          Math.max(1, geometry.prose - STOPPED_LABEL.length),
        ),
      ];
      rows.push({
        key: `${block.id}:${label}:${String(index)}`,
        gutter: [railCell(THEME.border), blankCell()],
        content,
        contentWidth: geometry.prose,
        meta: [],
      });
    });
  };
  listed("done", block.done);
  listed("not done", block.notDone);
  return rows;
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
  if (blocks.length === 0) forgetStreamingRows();
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
  useEffect(() => releaseTranscriptCaches, []);
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
