/** @jsxImportSource @opentui/react */

/**
 * The transcript: the one region that is actually *read* rather than glanced at.
 *
 * Two decisions carry the whole design.
 *
 * The first is the measure. `measureFor` sets running prose to ~88 columns and
 * hands the surplus to a flush-right metadata column, so a timestamp and a
 * sentence can never collide and the eye always returns to the same left edge.
 * Tool output, tables and code fences opt out and take the full content width —
 * those are scanned, not read, and a table squeezed to 88 columns is worse than
 * a table that reaches the frame.
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

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, type ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { THEME } from "../theme";
import { measureFor, type Block, type Focus, type ToolReceiptBlock, type Viewport } from "./types";

/** The rail lives in the left page margin, so the content column never moves. */
const GUTTER = 2;

/** Metadata stops here, so nothing ever touches the page's right edge. */
const RIGHT_MARGIN = 2;

/** Past this the transcript stops widening: see `pageWidth`. */
const PAGE_MAX_WIDTH = 120;

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

function cells(text: string): number {
  return [...text].length;
}

function segmentsWidth(segments: readonly Segment[]): number {
  return segments.reduce((total, segment) => total + cells(segment.text), 0);
}

function truncate(segments: readonly Segment[], max: number): readonly Segment[] {
  if (segmentsWidth(segments) <= max) return segments;
  const kept: Segment[] = [];
  let remaining = Math.max(0, max);
  for (const segment of segments) {
    if (remaining === 0) break;
    const characters = [...segment.text];
    if (characters.length <= remaining) {
      kept.push(segment);
      remaining -= characters.length;
    } else {
      kept.push({ ...segment, text: characters.slice(0, remaining).join("") });
      remaining = 0;
    }
  }
  return kept;
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
    if (
      last !== undefined &&
      last.fg === segment.fg &&
      last.bold === segment.bold &&
      last.italic === segment.italic
    ) {
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
        const size = cells(word);
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
        while (cells(rest) > width) {
          const head = [...rest].slice(0, width - used).join("");
          push({ ...segment, text: head });
          lines.push(line);
          line = [];
          used = 0;
          rest = [...rest].slice(cells(head)).join("");
        }
        push({ ...segment, text: rest });
        used += cells(rest);
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
  | { readonly kind: "fence"; readonly lines: readonly string[] }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] };

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/;

/** Inline emphasis, code, links and citations, as styled spans. */
export function inlineSegments(
  text: string,
  fg: string,
  glyphs: GlyphSet = getGlyphs(),
): Segment[] {
  const segments: Segment[] = [];
  for (const piece of text.split(INLINE)) {
    if (piece.length === 0) continue;
    if (/^(\*\*|__).+\1$/.test(piece)) {
      segments.push({ text: piece.slice(2, -2), fg: THEME.selected, bold: true });
    } else if (/^[*_].+[*_]$/.test(piece)) {
      segments.push({ text: piece.slice(1, -1), fg, italic: true });
    } else if (piece.startsWith("`") && piece.endsWith("`")) {
      segments.push({ text: piece.slice(1, -1), fg: THEME.syntaxValue });
    } else if (piece.startsWith("[")) {
      const label = piece.slice(1, piece.indexOf("]"));
      segments.push({ text: label, fg: THEME.link });
    } else {
      segments.push(...citations(piece, fg, glyphs));
    }
  }
  return segments;
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

/** Split agent markdown into items that read at the measure and items that scan. */
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
      items.push({ kind: "fence", lines: body });
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

    const bullet = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet !== null) {
      const depth = Math.floor(cells(bullet[1] ?? "") / 2);
      items.push({
        kind: "text",
        indent: depth * 2 + 2,
        segments: [
          { text: `${glyphs.bullet} `, fg: THEME.border },
          ...inlineSegments(bullet[2] ?? "", THEME.selected, glyphs),
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
        /^\s*(\||```|#{1,6}\s|>|[-*+]\s|\d+\.\s)/.test(candidate)
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

/** Borderless columns: a table is scanned, so its chrome is whitespace. */
function tableRows(
  rows: readonly (readonly string[])[],
  width: number,
  key: string,
  rail: Segment,
): RenderRow[] {
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => cells(row[column] ?? "")), 1),
  );
  const total = natural.reduce((sum, size) => sum + size, 0) + RECEIPT_GAP * (columns - 1);
  const scale = total > width ? width / total : 1;
  const sizes = natural.map((size) => Math.max(3, Math.floor(size * scale)));

  return rows.map((row, rowIndex) => {
    const fg = rowIndex === 0 ? THEME.muted : THEME.secondary;
    const segments: Segment[] = [];
    row.slice(0, columns).forEach((cell, column) => {
      const size = sizes[column] ?? 3;
      const text = [...cell].slice(0, size).join("").padEnd(size, " ");
      segments.push({ text, fg });
      if (column < columns - 1) segments.push({ text: " ".repeat(RECEIPT_GAP), fg });
    });
    return {
      key: `${key}:table:${String(rowIndex)}`,
      gutter: [rail, BLANK_CELL],
      content: truncate(segments, width),
      contentWidth: width,
      meta: [],
    };
  });
}

// ─── Blocks to rows ──────────────────────────────────────────────────────────

const BLANK_CELL: Segment = { text: " ", fg: THEME.border };

function railCell(color: string, glyphs: GlyphSet, deep = false): Segment {
  return { text: deep ? glyphs.railDeep : glyphs.rail, fg: color };
}

function blankRow(key: string, contentWidth: number): RenderRow {
  return { key, gutter: [], content: [], contentWidth, meta: [] };
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
  return family(block) !== family(previous);
}

interface Geometry {
  readonly prose: number;
  readonly content: number;
  readonly metadata: number;
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
  return lines.map((line, index) => ({
    key: `${block.id}:${String(index)}`,
    gutter: [index === 0 ? { text: glyphs.promptCursor, fg: THEME.primary } : rail, BLANK_CELL],
    content: line,
    contentWidth: geometry.prose,
    meta: index === 0 ? meta : [],
  }));
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

  parseProse(block.markdown, glyphs).forEach((item, itemIndex) => {
    const key = `${block.id}:${String(itemIndex)}`;
    switch (item.kind) {
      case "blank":
        rows.push(blankRow(key, geometry.prose));
        return;
      case "rule":
        rows.push({
          key,
          gutter: gutterFor(),
          content: [{ text: glyphs.divider.repeat(geometry.prose), fg: THEME.border }],
          contentWidth: geometry.prose,
          meta: [],
        });
        return;
      case "fence":
        item.lines.forEach((line, lineIndex) => {
          rows.push({
            key: `${key}:${String(lineIndex)}`,
            gutter: gutterFor(),
            content: truncate([{ text: line, fg: THEME.syntaxValue }], geometry.content),
            contentWidth: geometry.content,
            meta: [],
          });
        });
        return;
      case "table":
        rows.push(...tableRows(item.rows, geometry.content, key, rail));
        first = false;
        return;
      default: {
        const indent = item.indent;
        const lines = wrap(item.segments, geometry.prose - indent);
        lines.forEach((line, lineIndex) => {
          const padded =
            indent > 0 ? [{ text: " ".repeat(indent), fg: THEME.border }, ...line] : line;
          rows.push({
            key: `${key}:${String(lineIndex)}`,
            gutter: gutterFor(),
            content: padded,
            contentWidth: geometry.prose,
            meta: [],
          });
        });
      }
    }
  });

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
    const parts = [steps > 0 ? `thought ${String(steps)} steps` : "thought", "ctrl+o expands"];
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
  return wrap([{ text: block.text, fg: THEME.muted }], measure - REASONING_INDENT).map(
    (line, index) => ({
      key: `${block.id}:${String(index)}`,
      gutter: [rail, BLANK_CELL],
      content: [{ text: " ".repeat(REASONING_INDENT), fg: THEME.border }, ...line],
      contentWidth: geometry.prose,
      meta: index === 0 ? meta : [],
    }),
  );
}

/** A settled receipt: what it did and what came back, and nothing else. */
function receiptSegments(block: ToolReceiptBlock, glyphs: GlyphSet): Segment[] {
  if (block.status === "ok") {
    return [
      { text: block.app, fg: THEME.muted },
      { text: `  ${block.summary}`, fg: THEME.muted },
    ];
  }
  // Failure is the one exception that keeps a colour, and it carries the reason
  // and the way out on the same row.
  const tone = block.status === "denied" ? THEME.warning : THEME.error;
  const segments: Segment[] = [
    { text: block.app, fg: tone },
    { text: `  ${block.summary}`, fg: tone },
  ];
  if (block.reason !== undefined) {
    segments.push({ text: ` ${glyphs.bullet} ${block.reason}`, fg: THEME.secondary });
  }
  if (block.remedyKey !== undefined) {
    segments.push({ text: ` ${glyphs.bullet} ${block.remedyKey}`, fg: THEME.muted });
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
      rows.push({
        key: `${block.id}:0`,
        gutter: [block.status === "ok" ? rail : marker, BLANK_CELL],
        content: truncate(segments, geometry.prose),
        contentWidth: geometry.prose,
        meta,
      });
      // Expanded output is scanned, so it takes the full content width.
      if (block.expanded === true && block.detail !== undefined) {
        block.detail.split("\n").forEach((line, index) => {
          rows.push({
            key: `${block.id}:detail:${String(index)}`,
            gutter: [rail, BLANK_CELL],
            content: truncate([{ text: line, fg: THEME.muted }], geometry.content),
            contentWidth: geometry.content,
            meta: [],
          });
        });
      }
      continue;
    }

    const size = segmentsWidth(segments);
    const used = segmentsWidth(packed);
    if (used > 0 && used + RECEIPT_GAP * 2 + size > geometry.prose) flush();
    if (segmentsWidth(packed) > 0) {
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
  return wrap([{ text: block.text, fg: tone }], geometry.prose).map((line, index) => ({
    key: `${block.id}:${String(index)}`,
    gutter: [index === 0 ? { text: glyph, fg: tone } : railCell(THEME.border, glyphs), BLANK_CELL],
    content: line,
    contentWidth: geometry.prose,
    meta: [],
  }));
}

function dividerRows(
  block: Extract<Block, { kind: "divider" }>,
  geometry: Geometry,
  glyphs: GlyphSet,
): RenderRow[] {
  const label = block.label.length > 0 ? `${block.label} ` : "";
  const rule = glyphs.divider.repeat(Math.max(0, geometry.content - cells(label)));
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
      content: truncate(
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
    wrap([{ text: block.result, fg: THEME.secondary }], geometry.prose - 2).forEach(
      (line, index) => {
        rows.push({
          key: `${block.id}:result:${String(index)}`,
          gutter: [index === 0 ? { text: glyphs.laneEnd, fg: THEME.border } : rail, tag],
          content: [{ text: " ".repeat(2), fg: THEME.border }, ...line],
          contentWidth: geometry.prose,
          meta: [],
        });
      },
    );
  }

  return rows;
}

/**
 * The width the transcript actually lays out on, which is not the width of the
 * terminal. The transcript is a *page*: past 120 columns the surplus is left
 * empty rather than spent, because a metadata column pushed 100 columns away
 * from the sentence it annotates is no longer flush right, it is lost. So the
 * page stops and the frame gets wider around it.
 */
export function pageWidth(viewport: Viewport): number {
  return Math.min(viewport.width, PAGE_MAX_WIDTH);
}

/** The whole transcript as physical rows. Pure: blocks and a width, nothing else. */
export function transcriptRows(blocks: readonly Block[], viewport: Viewport): RenderRow[] {
  const glyphs = getGlyphs();
  const measure = measureFor(pageWidth(viewport));
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
      rows.push(...receiptRows(run, geometry, glyphs));
      continue;
    }

    switch (block.kind) {
      case "user":
        rows.push(...userRows(block, geometry, glyphs));
        break;
      case "agent":
        rows.push(...agentRows(block, geometry, glyphs));
        break;
      case "reasoning":
        rows.push(...reasoningRows(block, geometry, glyphs));
        break;
      case "notice":
        rows.push(...noticeRows(block, geometry, glyphs));
        break;
      case "divider":
        rows.push(...dividerRows(block, geometry, glyphs));
        break;
      case "lane":
        rows.push(...laneRows(block, geometry, glyphs));
        break;
    }
    index += 1;
  }

  return rows;
}

// ─── The region ──────────────────────────────────────────────────────────────

function Spans({ segments }: { segments: readonly Segment[] }): ReactNode {
  if (segments.length === 0) return null;
  return (
    <text style={{ wrapMode: "none", truncate: true }}>
      {segments.map((segment, index) => (
        <span
          key={`${String(index)}:${segment.text}`}
          style={{
            fg: segment.fg,
            ...(segment.bold === true ? { bold: true } : {}),
            ...(segment.italic === true ? { italic: true } : {}),
          }}
        >
          {segment.text}
        </span>
      ))}
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
}

export function Transcript({ blocks, viewport, focus, newBelow }: TranscriptProps): ReactNode {
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const rows = transcriptRows(blocks, viewport);
  const page = pageWidth(viewport);

  // Following the live edge is the default; `newBelow` is the one signal that
  // the reader has taken the scroll position for themselves.
  useEffect(() => {
    if (newBelow === undefined) scroll.current?.scrollTo({ x: 0, y: scroll.current.scrollHeight });
  }, [newBelow, rows.length]);

  const marker =
    newBelow !== undefined && newBelow > 0 ? `${String(newBelow)} new below  end jumps` : undefined;

  return (
    <box style={{ width: viewport.width, flexGrow: 1, flexShrink: 1, flexDirection: "column" }}>
      <scrollbox
        ref={scroll}
        focused={focus === "transcript"}
        style={{ flexGrow: 1, flexShrink: 1 }}
        stickyScroll={true}
        stickyStart="bottom"
        scrollbarOptions={{ visible: false }}
      >
        {rows.map((row) => (
          <Row
            key={row.key}
            row={row}
            width={page}
          />
        ))}
      </scrollbox>

      {/* The only bright accent allowed while scrolled up, and it costs one row
          of overlay rather than a row of layout — the transcript must not shift
          under the reader when this appears. */}
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
}
