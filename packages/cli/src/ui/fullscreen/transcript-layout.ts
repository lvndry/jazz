/**
 * Instance-owned transcript layout, separate from React painting and navigation.
 * Call update with an immutable document and an explicit geometry/glyph/theme
 * epoch. The returned index stores chunk heights and compact semantic offsets;
 * window() realizes only intersecting chunks. Wrapped rows use a bounded LRU,
 * and live-prefix reuse has the same row budget. dispose() releases all derived
 * state and retires the owner: update/window/flatten reject subsequent use.
 * flatten() is deliberately exhaustive and intended for tests/benchmarks.
 * A single oversized block is wrapped transiently, then released from the cache.
 */
import { isDiffReceiptTool } from "@jazz/core/utils/tool-formatter";
import { spaceReasoningSections } from "../../presentation/format-utils";
import { type GlyphSet } from "../glyphs";
import { measureFor, type Block, type StoppedBlock, type ToolReceiptBlock } from "./types";
import { parseMarkdown, type MarkdownBlock } from "../markdown/parse";
import { markdownRoleColor, type MarkdownSpan } from "../markdown/spans";
import { layoutTable } from "../markdown/table";
import { stoppedHeading } from "../models/interrupt";
import { outputPreviewExpandKey, receiptDiffRows, receiptParts } from "../models/receipt";
import { reportLines, type ReportSegment } from "../report-layout";
import { formatPreciseDuration } from "../text/format";
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
  wrapTerminalCells,
} from "../text/terminal-cells";
import { wrapStyledSpans } from "../text/wrap";
import { THEME as CURRENT_THEME, type ThemeColors } from "../theme";
import { foldedThoughtLine, thoughtLabel } from "../turn-thought";
import type { RowSource, ViewportRowIndex } from "./viewport-controller";

export interface Segment {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly link?: string;
}

export interface RenderRow {
  readonly key: string;
  /** Semantic content position, supplied before wrapping when a row contains prose. */
  readonly source?: RowSource | undefined;
  /** Two cells: rail or marker, then the lane tag. */
  readonly gutter: readonly Segment[];
  readonly content: readonly Segment[];
  /** `prose` for running text, the full content width for scanned output. */
  readonly contentWidth: number;
  readonly meta: readonly Segment[];
  /**
   * A surface behind the content cells. The band flags extend it over the
   * gutter or the whole conversation row.
   */
  readonly backgroundColor?: string;
  readonly bandIncludesGutter?: boolean;
  readonly bandFullWidth?: boolean;
}

export interface TranscriptRow extends RenderRow {
  readonly source: RowSource;
}

export const LIVE_REASONING_LINES = 3;
const REASONING_INDENT = 2;
const RECEIPT_GAP = 2;

export interface TranscriptLayoutEpoch {
  readonly width: number;
  readonly glyphs: GlyphSet;
  readonly themeRevision: number;
  readonly colors: Readonly<ThemeColors>;
}

export interface TranscriptLayoutIndex extends ViewportRowIndex<TranscriptRow> {
  /** Deliberately realizes every row; production selects window() instead. */
  flatten(): readonly TranscriptRow[];
}

export interface TranscriptLayout {
  update(blocks: readonly Block[], epoch: TranscriptLayoutEpoch): TranscriptLayoutIndex;
  dispose(): void;
  /** Retained painted rows, including the current streamed-prefix budget. */
  stats(): {
    readonly cachedRows: number;
    readonly cachedChunks: number;
    readonly sourceRows: number;
  };
}

export function createTranscriptLayout(
  options: { readonly cacheRows?: number; readonly cacheChunks?: number } = {},
): TranscriptLayout {
  const cacheRowLimit = options.cacheRows ?? 2048;
  const cacheChunkLimit = options.cacheChunks ?? 32;
  if (
    !Number.isSafeInteger(cacheRowLimit) ||
    cacheRowLimit < 0 ||
    !Number.isSafeInteger(cacheChunkLimit) ||
    cacheChunkLimit < 0
  ) {
    throw new RangeError("Transcript cache budgets must be nonnegative safe integers");
  }
  let themeRevision = 0;
  let palette: Readonly<ThemeColors> = { ...CURRENT_THEME };
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

  /** Locate wrapped spans in their unwrapped semantic text, including skipped wrap whitespace. */
  function semanticSources(
    lines: readonly (readonly Segment[])[],
    text: string,
    blockId: string,
    partId: string,
  ): RowSource[] {
    let cursor = 0;
    return lines.map((line) => {
      const content = line.map((span) => span.text).join("");
      const located = content.length === 0 ? cursor : text.indexOf(content, cursor);
      const start = located < 0 ? cursor : located;
      const end = start + content.length;
      cursor = end;
      return { blockId, partId, start, end };
    });
  }

  const anchoredRows = new WeakMap<RenderRow, TranscriptRow>();

  function anchorRow(row: RenderRow, blockId: string): TranscriptRow {
    const cached = anchoredRows.get(row);
    if (cached !== undefined) return cached;
    const anchored: TranscriptRow = {
      ...row,
      source: row.source ?? { blockId, partId: row.key, start: 0, end: 0 },
    };
    anchoredRows.set(row, anchored);
    return anchored;
  }

  /** Packed receipts retain the identity of their first receipt, not the first tool in the run. */
  function anchorReceiptRows(
    run: readonly ToolReceiptBlock[],
    rows: readonly RenderRow[],
  ): TranscriptRow[] {
    const ids = new Set(run.map((block) => block.id));
    return rows.map((row) => {
      let end = row.key.length;
      while (end > 0) {
        const id = row.key.slice(0, end);
        if (ids.has(id)) return anchorRow(row, id);
        end = row.key.lastIndexOf(":", end - 1);
      }
      return anchorRow(row, run[0]?.id ?? row.key);
    });
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
      fg: markdownRoleColor(span.role, palette),
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
        content = [{ text: glyphs.divider.repeat(layout.width), fg: palette.border }];
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
    return { text: " ", fg: palette.border };
  }

  // Blank, not the rail glyph — copy-pasting a reply must not drag a bar along.
  function railCell(color: string): Segment {
    return { text: " ", fg: color };
  }

  function blankRow(key: string, contentWidth: number): RenderRow {
    return {
      key,
      gutter: [railCell(palette.border), blankCell()],
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
    readonly prose: number;
    readonly content: number;
    readonly page: number;
  }

  /** All conversation content uses the available width, with two cells on each side. */
  function geometryFor(width: number): Geometry {
    const { prose } = measureFor(width);
    return { prose, content: prose, page: prose };
  }

  /** Reserve space only for metadata present on this row. */
  function widthWithMetadata(geometry: Geometry, meta: readonly Segment[]): number {
    return Math.max(1, geometry.content - (meta.length > 0 ? terminalSegmentsWidth(meta) + 2 : 0));
  }

  function wrapEpoch(width: number, glyphs: GlyphSet): string {
    return `${String(width)}\0${String(themeRevision)}\0${JSON.stringify(glyphs)}`;
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
   * Render a user turn with a full-width neutral background and wrapped prose.
   */
  function userRows(
    block: Extract<Block, { kind: "user" }>,
    geometry: Geometry,
    glyphs: GlyphSet,
  ): RenderRow[] {
    const meta: readonly Segment[] =
      block.at !== undefined ? [{ text: block.at, fg: palette.muted }] : [];
    const contentWidth = widthWithMetadata(geometry, meta);
    const lines = wrap(
      [{ text: block.text, fg: palette.selected }],
      Math.max(1, contentWidth - BAND_PADDING),
    );
    const sources = semanticSources(lines, block.text, block.id, "body");
    const bar: readonly Segment[] = [{ text: glyphs.bandBar, fg: palette.primary }, blankCell()];
    const panel = (
      key: string,
      content: readonly Segment[],
      rowMeta: readonly Segment[],
    ): RenderRow => ({
      key,
      gutter: bar,
      content,
      contentWidth,
      meta: rowMeta,
      backgroundColor: palette.surface,
      bandFullWidth: true,
    });
    // One row of panel above and below the text: the band reads as a surface
    // the message sits on, not a highlighter stroke through it.
    const rows: RenderRow[] = [panel(`${block.id}:top`, [], [])];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      rows.push({
        ...panel(`${block.id}:${String(index)}`, line, index === 0 ? meta : []),
        source: sources[index],
      });
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

  function agentRowStyle(
    block: Extract<Block, { kind: "agent" }>,
    glyphs: GlyphSet,
  ): AgentRowStyle {
    // Colour is state, not speaker: the rail is accent only while tokens land.
    const streaming = block.streaming === true;
    return {
      rail: railCell(streaming ? palette.agent : palette.border),
      marker: { text: glyphs.diamond, fg: streaming ? palette.agent : palette.secondary },
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
            content: [{ text: glyphs.divider.repeat(geometry.prose), fg: palette.border }],
            contentWidth: geometry.prose,
            meta: [],
          });
          break;
        case "heading": {
          breathe(key);
          const lines = wrap(segmentsOf(item.spans), geometry.prose);
          const sources = semanticSources(
            lines,
            item.spans.map((span) => span.text).join(""),
            blockId,
            `part:${String(offset + itemIndex)}`,
          );
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            if (line === undefined) continue;
            rows.push({
              key: `${key}:${String(lineIndex)}`,
              source: sources[lineIndex],
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
          const sources = semanticSources(
            lines,
            item.spans.map((span) => span.text).join(""),
            blockId,
            `part:${String(offset + itemIndex)}`,
          );
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            if (line === undefined) continue;
            const lead: Segment[] = [];
            if (indent > 0) lead.push({ text: " ".repeat(indent), fg: palette.border });
            if (marker !== undefined) {
              // Wrapped rows hang under the text rather than the marker, so the
              // marker column stays a clean edge the eye can run down.
              lead.push(
                lineIndex === 0 || item.repeatMarker === true
                  ? marker
                  : { text: " ".repeat(markerWidth), fg: palette.border },
              );
            }
            rows.push({
              key: `${key}:${String(lineIndex)}`,
              source: sources[lineIndex],
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
  function forgetStreamingRows(): void {
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
    streamingProseCache =
      settled.state.rows.length <= cacheRowLimit && settled.prefix.length <= cacheRowLimit * 256
        ? settled
        : undefined;

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
    const cursor: Segment = { text: glyphs.streamCursor, fg: palette.agent };
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
    appendProseItems(
      state,
      parseProse(block.markdown, glyphs),
      0,
      block.id,
      style,
      geometry,
      glyphs,
    );
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
      backgroundColor: palette.surfaceStrong,
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
            { text: " ".repeat(labelOffset), fg: palette.muted },
            { text: label, fg: palette.muted },
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
  const sameSyntaxStyle = (previous: SyntaxSpan, current: SyntaxSpan): boolean =>
    previous.fg === current.fg;

  /**
   * The painted surface rows one source line occupies. A long line is word-
   * wrapped so code cannot run off the edge and be lost: one row per wrapped
   * fragment, each the full band width.
   */
  function fenceCodeRows(
    baseKey: string,
    spans: readonly SyntaxSpan[],
    layout: FenceLayout,
    gutter: readonly Segment[],
  ): RenderRow[] {
    return wrapStyledSpans(
      spans.map((span) => ({ text: span.text, fg: span.fg })),
      layout.inner,
      sameSyntaxStyle,
    ).map((line, index) => fenceSurface(`${baseKey}:${String(index)}`, line, layout.width, gutter));
  }

  function fenceRows(
    language: string,
    lines: readonly string[],
    geometry: Geometry,
    key: string,
    gutterFor: () => readonly Segment[],
  ): RenderRow[] {
    const painted = highlightFenceLines(language, lines, palette);
    const layout = fenceLayout(
      Math.max(0, ...lines.map((line) => terminalCellWidth(line))),
      geometry,
    );
    const rows: RenderRow[] = [fenceLabelRow(language, layout, key, gutterFor())];
    for (let lineIndex = 0; lineIndex < painted.length; lineIndex += 1) {
      const spans = painted[lineIndex];
      if (spans === undefined) continue;
      rows.push(...fenceCodeRows(`${key}:${String(lineIndex)}`, spans, layout, gutterFor()));
    }
    rows.push(fenceSurface(`${key}:fence:bottom`, [], layout.width, gutterFor()));
    return rows;
  }

  /**
   * The fence a streaming answer is writing into. It has no blank line outside
   * itself to settle at, so without this every reveal frame would re-highlight
   * and re-wrap its whole body. Settled lines keep their highlight and their row;
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
    /** Rows for the settled lines, wrapped to `layout`, all spans from `highlight`. */
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
    const highlight = continueFenceHighlight(previous?.highlight, language, lines, palette);
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
    // Reuse the cached wrapped rows only when the band width is unchanged and the
    // settled spans are still identical: a wrap depends only on layout.inner and the
    // span text, so neither having moved means the rows still hold. The rows cover
    // the cached `measuredLines` spans, so new lines start there, not after the rows.
    const reuse =
      resumed &&
      previous.layout.width === layout.width &&
      previous.layout.inner === layout.inner &&
      previous.settledRows.length > 0 &&
      previous.settledSpans.every((spans, index) => spans === settledSpans[index]);
    const start = reuse ? previous.measuredLines : 0;
    const settledRows = reuse ? previous.settledRows.slice() : [];
    for (let index = start; index < settledCount; index += 1) {
      settledRows.push(
        ...fenceCodeRows(`${key}:${String(index)}`, settledSpans[index] ?? [], layout, rail),
      );
    }
    openFenceCache =
      settledRows.length <= cacheRowLimit &&
      lines.reduce((characters, line) => characters + line.length, 0) <= cacheRowLimit * 256
        ? {
            key,
            epoch,
            highlight,
            longestSettled,
            measuredLines: settledCount,
            layout,
            settledRows,
            settledSpans,
          }
        : undefined;

    const rows: RenderRow[] = [top, ...settledRows];
    if (lines.length > 0) {
      rows.push(
        ...fenceCodeRows(
          `${key}:${String(lines.length - 1)}`,
          highlight.spans[lines.length - 1] ?? [],
          layout,
          rail,
        ),
      );
    }
    rows.push(fenceSurface(`${key}:fence:bottom`, [], layout.width, rail));
    return rows;
  }

  /** While the model thinks, only its newest lines show, so reasoning cannot push the conversation away. */

  /**
   * Reasoning is the model's scratchpad, never its answer: italic, muted, behind
   * a thin rule. It has three states.
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
    const rail = railCell(palette.border);
    const gutter: readonly Segment[] = [rail, blankCell()];
    const indent: Segment = { text: " ".repeat(REASONING_INDENT), fg: palette.border };
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
            fg: palette.muted,
          },
        ]),
      ];
    }

    const measure = geometry.prose;
    const ruled: Segment = { text: `${glyphs.railDeep} `, fg: palette.border };
    const text = spaceReasoningSections(block.text);
    const wrapped = wrap(
      [{ text, fg: palette.muted, italic: true }],
      measure - REASONING_INDENT - 2,
    );
    const sources = semanticSources(wrapped, text, block.id, "body");
    const bodyRows = (lines: readonly (readonly Segment[])[], keyOffset: number): RenderRow[] =>
      lines.map((line, index) => ({
        ...row(`${block.id}:${String(keyOffset + index)}`, [indent, ruled, ...line]),
        source: sources[keyOffset + index],
      }));

    // The live zone right below says "thinking" with the elapsed time, so the
    // lines carry no label of their own; a second one would stack the word twice.
    if (block.live === true) {
      const newest = text.trim().length === 0 ? [] : wrapped.slice(-LIVE_REASONING_LINES);
      return bodyRows(newest, Math.max(0, wrapped.length - newest.length));
    }

    return [
      row(`${block.id}:label`, [
        indent,
        { text: `${glyphs.unfolded} ${thoughtLabel(block)}`, fg: palette.secondary },
      ]),
      ...bodyRows(wrapped, 0),
      row(`${block.id}:fold`, [
        indent,
        { text: `ctrl+r to fold${separator}again for the previous block`, fg: palette.muted },
      ]),
    ];
  }

  function highlightedArgs(args: string, fallbackFg: string, app: string): Segment[] {
    const path = pathFromFileArgsPreview(args);
    const language = path === undefined ? undefined : sourceLanguageFromPath(path);
    if (language === undefined && !isDiffReceiptTool(app)) {
      return [{ text: `  ${args}`, fg: fallbackFg }];
    }
    return [{ text: "  ", fg: fallbackFg }, ...highlightCodeLine(args, "", palette)];
  }

  function partSegment(part: RoleSegment): Segment {
    const style = roleStyle(part.role, palette);
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
        ? highlightedArgs(
            argsPart.text.trimStart(),
            roleStyle(argsPart.role, palette).fg,
            block.app,
          )
        : [partSegment(argsPart)];
    const room = budget - terminalSegmentsWidth(head) - terminalSegmentsWidth(tail);
    if (terminalSegmentsWidth(argSegments) <= room) {
      return [...head, ...argSegments, ...tail];
    }
    if (room <= 4) {
      return [...head, ...tail];
    }
    const cropped = fitTerminalSegments(argSegments, room - 1);
    return [...head, ...cropped, { text: "…", fg: palette.muted }, ...tail];
  }

  const COMMAND_PREVIEW_DISPLAY_CHARS = 48;

  function previewDisplay(preview: string): string {
    return preview.length > COMMAND_PREVIEW_DISPLAY_CHARS
      ? `${preview.slice(0, COMMAND_PREVIEW_DISPLAY_CHARS - 1).trimEnd()}…`
      : preview;
  }

  function outputPreviewRows(
    block: ToolReceiptBlock,
    geometry: Geometry,
    rail: Segment,
  ): RenderRow[] {
    const preview = block.outputPreview?.trim();
    const previewText = preview === undefined ? undefined : previewDisplay(preview);
    if (previewText === undefined || previewText.length === 0) return [];
    const expanded = block.expanded === true && block.detail !== undefined;
    const hint =
      expanded || block.detail === undefined || block.detail.trim() === preview
        ? ""
        : ` · ${outputPreviewExpandKey(block.app)} to expand`;
    return [
      {
        key: `${block.id}:preview`,
        gutter: [rail, blankCell()],
        content: fitTerminalSegments(
          [{ text: `  ${previewText}${hint}`, fg: palette.secondary }],
          geometry.content,
        ),
        contentWidth: geometry.content,
        meta: [],
      },
    ];
  }

  /** Pack short receipts; wrap any tool call that needs more than one row. */
  function receiptRows(
    blocks: readonly ToolReceiptBlock[],
    geometry: Geometry,
    glyphs: GlyphSet,
  ): RenderRow[] {
    const rail = railCell(palette.border);
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
      const meta: readonly Segment[] =
        block.expanded === true && block.durationMs !== undefined
          ? [{ text: formatPreciseDuration(block.durationMs), fg: palette.muted }]
          : [];
      const contentWidth = widthWithMetadata(geometry, meta);
      const segments = receiptSegments(block, glyphs, contentWidth);
      const needsOwnRows =
        block.status !== "ok" ||
        block.expanded === true ||
        block.diffPreview !== undefined ||
        block.outputPreview !== undefined ||
        segments.some((segment) => segment.text.includes("\n")) ||
        terminalSegmentsWidth(segments) > contentWidth;

      if (needsOwnRows) {
        flush();
        const marker =
          block.status === "denied"
            ? { text: glyphs.proposed, fg: palette.warning }
            : block.status === "failed"
              ? { text: glyphs.error, fg: palette.error }
              : { text: glyphs.pending, fg: palette.muted };
        if (segments.some((segment) => segment.text.trim().length > 0)) {
          const lines = wrap(segments, contentWidth);
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const line = lines[lineIndex];
            if (line === undefined) continue;
            rows.push({
              key: `${block.id}:${String(lineIndex)}`,
              gutter: [lineIndex === 0 && block.status !== "ok" ? marker : rail, blankCell()],
              content: line,
              contentWidth,
              meta: lineIndex === 0 ? meta : [],
            });
          }
        }
        if (block.expanded !== true) {
          for (const row of outputPreviewRows(block, geometry, rail)) {
            rows.push(row);
          }
        }
        if (block.expanded === true && block.diffText !== undefined) {
          const fullDiffLines = block.diffText.split("\n");
          for (let index = 0; index < fullDiffLines.length; index += 1) {
            const diffLine = fullDiffLines[index];
            if (diffLine === undefined) continue;
            const role = diffLine.startsWith("+")
              ? "success"
              : diffLine.startsWith("-")
                ? "error"
                : diffLine.startsWith("@@")
                  ? "secondary"
                  : "muted";
            // Word-wrap the stored text to the content width: a diff line can
            // carry a full user quote and must not be clipped to one row.
            const wrapped = wrapTerminalCells(`  ${diffLine}`, geometry.content);
            for (let wrapIndex = 0; wrapIndex < wrapped.length; wrapIndex += 1) {
              const line = wrapped[wrapIndex];
              if (line === undefined) continue;
              rows.push({
                key: `${block.id}:difffull:${String(index)}:${String(wrapIndex)}`,
                gutter: [rail, blankCell()],
                content: [{ text: line, fg: roleStyle(role, palette).fg }],
                contentWidth: geometry.content,
                meta: [],
              });
            }
          }
        } else {
          const diffRows = receiptDiffRows(block);
          for (let index = 0; index < diffRows.length; index += 1) {
            const diffRow = diffRows[index];
            if (diffRow === undefined) continue;
            const wrapped = wrapTerminalCells(`  ${diffRow.text}`, geometry.content);
            for (let wrapIndex = 0; wrapIndex < wrapped.length; wrapIndex += 1) {
              const line = wrapped[wrapIndex];
              if (line === undefined) continue;
              rows.push({
                key: `${block.id}:diff:${String(index)}:${String(wrapIndex)}`,
                gutter: [rail, blankCell()],
                content: [{ text: line, fg: roleStyle(diffRow.role, palette).fg }],
                contentWidth: geometry.content,
                meta: [],
              });
            }
          }
        }
        if (block.expanded === true && block.detail !== undefined) {
          const detailLines = block.detail.split("\n");
          const painted = highlightFenceLines("", detailLines, palette);
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
        packed.push({ text: `  ${glyphs.bullet} `, fg: palette.border });
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
        ? palette.error
        : block.tone === "warn"
          ? palette.warning
          : block.tone === "receipt"
            ? palette.muted
            : palette.secondary;
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
            ? railCell(palette.border)
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
    const style = roleStyle(role, palette);
    return style.bold === true
      ? { text: "", fg: style.fg, bold: true }
      : { text: "", fg: style.fg };
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
      const indent: Segment = { text: " ".repeat(line.indent), fg: palette.muted };
      const prefix = [
        ...(line.indent > 0 ? [indent] : []),
        ...paint(line.segments.slice(0, line.lead)),
      ];
      const hang = terminalSegmentsWidth(prefix);
      const rest = paint(line.segments.slice(line.lead));
      const wrapped = rest.length === 0 ? [[]] : wrap(rest, Math.max(1, geometry.prose - hang));
      const continuation: Segment = { text: " ".repeat(hang), fg: palette.muted };
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
        gutter: [railCell(palette.border), blankCell()],
        content: [
          { text: label, fg: palette.muted },
          { text: rule, fg: palette.border },
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
        gutter: [railCell(palette.border), blankCell()],
        content: [
          { text: heading, fg: palette.muted },
          { text: rule, fg: palette.border },
        ],
        contentWidth: geometry.content,
        meta: [],
      },
    ];
    const listed = (label: string, items: readonly string[]): void => {
      const measure = Math.max(1, geometry.prose - STOPPED_LABEL.length);
      const indent: Segment = { text: " ".repeat(STOPPED_LABEL.length), fg: palette.muted };
      items.forEach((item, index) => {
        wrapTerminalCells(item, measure).forEach((line, wrapIndex) => {
          const content: Segment[] =
            wrapIndex === 0
              ? [
                  {
                    text: (index === 0 ? label : "").padEnd(STOPPED_LABEL.length),
                    fg: palette.muted,
                  },
                  { text: line, fg: palette.selected },
                ]
              : [indent, { text: line, fg: palette.selected }];
          rows.push({
            key: `${block.id}:${label}:${String(index)}:${String(wrapIndex)}`,
            gutter: [railCell(palette.border), blankCell()],
            content,
            contentWidth: geometry.prose,
            meta: [],
          });
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
    const railColor = live ? palette.accentDim : palette.border;
    const rail = railCell(railColor);
    // Holds the gutter at two cells so every block's content starts in the same
    // column, whether or not it is delegated.
    const tag: Segment = { text: " ", fg: palette.border };
    const marker: Segment = live
      ? { text: glyphs.pending, fg: palette.accentDim }
      : block.state === "failed"
        ? { text: glyphs.error, fg: palette.error }
        : { text: glyphs.success, fg: palette.secondary };

    const meta: readonly Segment[] = [
      {
        text:
          block.steps === undefined
            ? `lane ${String(block.lane)}`
            : `lane ${String(block.lane)} ${glyphs.bullet} ${String(block.steps)} steps`,
        fg: palette.muted,
      },
    ];
    const contentWidth = widthWithMetadata(geometry, meta);
    const askIndent = 2 + terminalCellWidth(block.name);
    const askRows = wrapTerminalCells(block.ask, Math.max(1, contentWidth - askIndent));
    const rows: RenderRow[] = [
      {
        key: `${block.id}:0`,
        gutter: [marker, tag],
        content: [
          { text: block.name, fg: palette.secondary },
          { text: `  ${askRows[0] ?? ""}`, fg: palette.muted },
        ],
        contentWidth,
        meta,
      },
    ];
    askRows.slice(1).forEach((line, wrapIndex) => {
      rows.push({
        key: `${block.id}:ask:${String(wrapIndex + 1)}`,
        gutter: [blankCell(), blankCell()],
        content: [
          { text: " ".repeat(askIndent), fg: palette.muted },
          { text: line, fg: palette.muted },
        ],
        contentWidth,
        meta,
      });
    });

    if (block.result !== undefined) {
      const lines = wrap([{ text: block.result, fg: palette.secondary }], geometry.prose - 2);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        rows.push({
          key: `${block.id}:result:${String(index)}`,
          gutter: [index === 0 ? { text: glyphs.laneEnd, fg: palette.border } : rail, tag],
          content: [{ text: " ".repeat(2), fg: palette.border }, ...line],
          contentWidth: geometry.prose,
          meta: [],
        });
      }
    }

    return rows;
  }

  interface SourcePart {
    readonly blockId: string;
    readonly partId: string;
    readonly rows: Uint32Array;
  }
  interface Chunk {
    readonly blocks: readonly Block[];
    readonly breathing: boolean;
    readonly epoch: TranscriptLayoutEpoch;
    readonly length: number;
    readonly parts: readonly SourcePart[];
    readonly partAt: Uint32Array;
    readonly starts: Uint32Array;
    readonly ends: Uint32Array;
  }

  let chunks: readonly Chunk[] = [];
  let lastBlocks: readonly Block[] | undefined;
  let lastChunks: readonly Chunk[] = [];
  let lastEpoch: string | undefined;
  let lastIndex: LayoutIndex | undefined;
  let cachedRowCount = 0;
  const rowCache = new Map<Chunk, readonly TranscriptRow[]>();
  let disposed = false;

  function assertActive(): void {
    if (disposed) throw new Error("Transcript layout is disposed");
  }

  function remember(chunk: Chunk, rows: readonly TranscriptRow[]): void {
    if (chunk.length > cacheRowLimit || cacheChunkLimit === 0) return;
    const previous = rowCache.get(chunk);
    if (previous !== undefined) cachedRowCount -= previous.length;
    rowCache.delete(chunk);
    rowCache.set(chunk, rows);
    cachedRowCount += rows.length;
    while (cachedRowCount > cacheRowLimit || rowCache.size > cacheChunkLimit) {
      const oldest = rowCache.keys().next().value;
      if (oldest === undefined) break;
      cachedRowCount -= rowCache.get(oldest)?.length ?? 0;
      rowCache.delete(oldest);
    }
  }

  function paint(
    blocks: readonly Block[],
    breathing: boolean,
    epoch: TranscriptLayoutEpoch,
  ): TranscriptRow[] {
    palette = epoch.colors;
    themeRevision = epoch.themeRevision;
    const geometry = geometryFor(epoch.width);
    const head = blocks[0];
    if (head === undefined) return [];
    const rows = breathing ? [anchorRow(blankRow(`gap:${head.id}`, geometry.prose), head.id)] : [];
    if (head.kind === "tool") {
      const run = blocks as readonly ToolReceiptBlock[];
      for (const row of anchorReceiptRows(run, receiptRows(run, geometry, epoch.glyphs)))
        rows.push(row);
    } else {
      for (const row of rowsForBlock(head, geometry, epoch.glyphs))
        rows.push(anchorRow(row, head.id));
    }
    return rows;
  }

  function realize(chunk: Chunk): readonly TranscriptRow[] {
    const hit = rowCache.get(chunk);
    if (hit !== undefined) {
      rowCache.delete(chunk);
      rowCache.set(chunk, hit);
      return hit;
    }
    const rows = paint(chunk.blocks, chunk.breathing, chunk.epoch);
    remember(chunk, rows);
    return rows;
  }

  function measure(
    blocks: readonly Block[],
    breathing: boolean,
    epoch: TranscriptLayoutEpoch,
  ): Chunk {
    const rows = paint(blocks, breathing, epoch);
    const identities = new Map<string, number>();
    const parts: { blockId: string; partId: string; rows: number[] }[] = [];
    const partAt = new Uint32Array(rows.length);
    const starts = new Uint32Array(rows.length);
    const ends = new Uint32Array(rows.length);
    for (let index = 0; index < rows.length; index++) {
      const source = rows[index]?.source;
      if (source === undefined) continue;
      const key = `${source.blockId}\0${source.partId}`;
      let ordinal = identities.get(key);
      if (ordinal === undefined) {
        ordinal = parts.length;
        identities.set(key, ordinal);
        parts.push({ blockId: source.blockId, partId: source.partId, rows: [] });
      }
      parts[ordinal]?.rows.push(index);
      partAt[index] = ordinal;
      starts[index] = source.start;
      ends[index] = source.end;
    }
    const chunk: Chunk = {
      blocks,
      breathing,
      epoch,
      length: rows.length,
      partAt,
      starts,
      ends,
      parts: parts.map((part) => ({ ...part, rows: Uint32Array.from(part.rows) })),
    };
    remember(chunk, rows);
    return chunk;
  }

  function sameBlocks(previous: readonly Block[], current: readonly Block[]): boolean {
    return (
      previous.length === current.length &&
      previous.every((block, index) => block === current[index])
    );
  }
  const INDEX_CONTEXT = Symbol.for("jazz.transcript-layout.index-context");

  type LayoutIndex = TranscriptLayoutIndex & Record<typeof INDEX_CONTEXT, IndexContext>;

  interface IndexContext {
    current: Chunk[];
    prefix: Float64Array;
    blocks: Map<string, { first: number; last: number }>;
    parts: Map<string, { chunk: number; part: SourcePart }[]>;
  }

  /**
   * Records one chunk's row offsets and source lookups into a shared index
   * context. Reused by the cold build and the incremental append/tail path
   * so both produce identical prefix/blocks/parts entries.
   */
  function indexChunk(chunk: Chunk, index: number, offset: number, context: IndexContext): number {
    context.prefix[index + 1] = offset + chunk.length;
    for (const part of chunk.parts) {
      const first = offset + (part.rows[0] ?? 0);
      const last = offset + (part.rows[part.rows.length - 1] ?? 0);
      const previous = context.blocks.get(part.blockId);
      context.blocks.set(part.blockId, {
        first: Math.min(previous?.first ?? first, first),
        last: Math.max(previous?.last ?? last, last),
      });
      const key = `${part.blockId}\0${part.partId}`;
      const spans = context.parts.get(key) ?? [];
      spans.push({ chunk: index, part });
      context.parts.set(key, spans);
    }
    return offset + chunk.length;
  }

  function indexAll(context: IndexContext): void {
    for (let index = 0; index < context.current.length; index++) {
      const chunk = context.current[index];
      if (chunk === undefined) continue;
      indexChunk(chunk, index, context.prefix[index] ?? 0, context);
    }
  }

  function indexFromContext(context: IndexContext): LayoutIndex {
    const current = context.current;
    const prefix = context.prefix;
    const blocks = context.blocks;
    const parts = context.parts;
    const length = prefix[current.length] ?? 0;
    let flattened: readonly TranscriptRow[] | undefined;
    function locate(position: number): number {
      let low = 0;
      let high = current.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if ((prefix[middle + 1] ?? 0) <= position) low = middle + 1;
        else high = middle;
      }
      return low;
    }
    function sourceAt(position: number): RowSource | undefined {
      if (position < 0 || position >= length) return undefined;
      const ordinal = locate(position);
      const chunk = current[ordinal];
      if (chunk === undefined) return undefined;
      const row = position - (prefix[ordinal] ?? 0);
      const part = chunk.parts[chunk.partAt[row] ?? 0];
      return part === undefined
        ? undefined
        : {
            blockId: part.blockId,
            partId: part.partId,
            start: chunk.starts[row] ?? 0,
            end: chunk.ends[row] ?? 0,
          };
    }
    function sourceRow(target: RowSource): number | undefined {
      const spans = parts.get(`${target.blockId}\0${target.partId}`);
      let nearest: number | undefined;
      let distance = Number.POSITIVE_INFINITY;
      for (const span of spans ?? []) {
        const chunk = current[span.chunk];
        if (chunk === undefined) continue;
        let low = 0;
        let high = span.part.rows.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const row = span.part.rows[middle] ?? 0;
          if ((chunk.starts[row] ?? 0) < target.start) low = middle + 1;
          else high = middle;
        }
        for (const candidate of [low, low - 1]) {
          const row = span.part.rows[candidate];
          if (row === undefined) continue;
          const start = chunk.starts[row] ?? 0;
          const position = (prefix[span.chunk] ?? 0) + row;
          if (
            start <= target.start &&
            ((chunk.ends[row] ?? 0) > target.start || start === target.start)
          )
            return position;
          const gap = Math.abs(start - target.start);
          if (
            gap < distance ||
            (gap === distance && (nearest === undefined || position < nearest))
          ) {
            distance = gap;
            nearest = position;
          }
        }
      }
      return nearest ?? blocks.get(target.blockId)?.first;
    }
    function window(top: number, count: number): readonly TranscriptRow[] {
      assertActive();
      const start = Math.max(0, Math.trunc(top));
      const end = Math.min(length, start + Math.max(0, Math.trunc(count)));
      const rows: TranscriptRow[] = [];
      if (end <= start) return rows;
      let ordinal = locate(start);
      while (ordinal < current.length && (prefix[ordinal] ?? 0) < end) {
        const chunk = current[ordinal];
        if (chunk === undefined) break;
        const offset = prefix[ordinal] ?? 0;
        const painted = realize(chunk);
        const from = Math.max(0, start - offset);
        const to = Math.min(painted.length, end - offset);
        for (let index = from; index < to; index++) {
          const row = painted[index];
          if (row !== undefined) rows.push(row);
        }
        ordinal++;
      }
      return rows;
    }
    return {
      [INDEX_CONTEXT]: context,
      length,
      sourceAt,
      sourceRow,
      window,
      hasPart: (source) => parts.has(`${source.blockId}\0${source.partId}`),
      blockBounds: (blockId) => blocks.get(blockId),
      flatten: () => {
        assertActive();
        return (flattened ??= window(0, length));
      },
    };
  }

  function update(blocks: readonly Block[], epoch: TranscriptLayoutEpoch): TranscriptLayoutIndex {
    assertActive();
    themeRevision = epoch.themeRevision;
    const signature = wrapEpoch(epoch.width, epoch.glyphs);
    if (blocks === lastBlocks && signature === lastEpoch && lastIndex !== undefined)
      return lastIndex;
    if (signature !== lastEpoch) {
      chunks = [];
      rowCache.clear();
      cachedRowCount = 0;
      forgetStreamingRows();
    }
    if (!blocks.some((block) => block.kind === "agent" && block.streaming === true))
      forgetStreamingRows();
    const capturedEpoch: TranscriptLayoutEpoch = {
      ...epoch,
      colors: { ...epoch.colors },
      glyphs: { ...epoch.glyphs },
    };
    const previous = new Map(chunks.map((chunk) => [chunk.blocks[0], chunk]));
    const next: Chunk[] = [];
    for (let index = 0; index < blocks.length;) {
      const head = blocks[index];
      if (head === undefined) break;
      const breathing = needsBreathingRow(head, blocks[index - 1]);
      const members: Block[] = [head];
      index++;
      if (head.kind === "tool") {
        while (blocks[index]?.kind === "tool") {
          const member = blocks[index];
          if (member !== undefined) members.push(member);
          index++;
        }
      }
      const hit = previous.get(head);
      next.push(
        hit !== undefined && hit.breathing === breathing && sameBlocks(hit.blocks, members)
          ? hit
          : measure(members, breathing, capturedEpoch),
      );
    }
    const retained = new Set(next);
    for (const [chunk, rows] of rowCache) {
      if (!retained.has(chunk)) {
        cachedRowCount -= rows.length;
        rowCache.delete(chunk);
      }
    }
    chunks = next;
    lastBlocks = blocks;
    lastEpoch = signature;
    const shared = Math.min(lastChunks.length, next.length);
    let reusable = 0;
    while (reusable < shared && lastChunks[reusable] === next[reusable]) reusable++;
    if (lastIndex === undefined || reusable === 0 || signature !== lastEpoch) {
      const context: IndexContext = {
        current: [...next],
        prefix: new Float64Array(next.length + 1),
        blocks: new Map(),
        parts: new Map(),
      };
      indexAll(context);
      lastIndex = indexFromContext(context);
    } else {
      const old = lastIndex[INDEX_CONTEXT];
      const prefix = new Float64Array(next.length + 1);
      prefix.set(old.prefix.subarray(0, reusable + 1), 0);
      const blocks = new Map<string, { first: number; last: number }>();
      const parts = new Map<string, { chunk: number; part: SourcePart }[]>();
      const boundary = old.prefix[reusable] ?? 0;
      for (const [key, value] of old.blocks) if (value.first < boundary) blocks.set(key, value);
      for (const [key, value] of old.parts)
        if (value.some((span) => span.chunk < reusable)) parts.set(key, value);
      const context: IndexContext = {
        current: [...next],
        prefix,
        blocks,
        parts,
      };
      for (let index = reusable; index < next.length; index++) {
        const chunk = next[index];
        if (chunk === undefined) continue;
        indexChunk(chunk, index, prefix[index] ?? 0, context);
      }
      lastIndex = indexFromContext(context);
    }
    lastChunks = next;
    return lastIndex;
  }

  return {
    update,
    dispose: () => {
      disposed = true;
      chunks = [];
      lastBlocks = undefined;
      lastIndex = undefined;
      lastEpoch = undefined;
      rowCache.clear();
      cachedRowCount = 0;
      forgetStreamingRows();
    },
    stats: () => ({
      cachedRows:
        cachedRowCount +
        (streamingProseCache?.state.rows.length ?? 0) +
        (openFenceCache?.settledRows.length ?? 0),
      cachedChunks: rowCache.size,
      sourceRows: lastIndex?.length ?? 0,
    }),
  };
}
