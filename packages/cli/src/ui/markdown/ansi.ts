import chalk from "chalk";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { parseMarkdown, type MarkdownBlock } from "./parse";
import {
  markdownRoleColor,
  sameMarkdownStyle,
  type MarkdownSpan,
  type MarkdownSyntax,
} from "./spans";
import { layoutTable } from "./table";
import { PROSE_MEASURE } from "../text/measure";
import { highlightFenceLines, type SyntaxSpan } from "../text/syntax-spans";
import {
  sliceTerminalCells,
  terminalCellWidth,
  terminalSegmentsWidth,
} from "../text/terminal-cells";
import { wrapStyledSpans } from "../text/wrap";
import { THEME } from "../theme";

export interface AnsiMarkdownOptions {
  /** Cells available. Prose stops at {@link PROSE_MEASURE}; tables and code may use all of it. */
  readonly width: number;
  readonly syntax?: MarkdownSyntax;
  readonly glyphs?: GlyphSet;
  /** Emit OSC 8 hyperlinks. Defaults to on whenever colour is, since both mean a real terminal. */
  readonly hyperlinks?: boolean;
  /**
   * Keep one blank line where the text starts or ends on one. A streamed
   * answer is cut into slices at paragraph breaks and each slice is laid out
   * on its own, so the break has to survive at the slice's edge.
   */
  readonly keepEdgeBlankLines?: boolean;
  /**
   * Wrap prose (paragraphs, headings, list and quote text) to the measure. Defaults to on.
   *
   * Off for a renderer with its own live reflow — Ink's `<Text wrap>` re-wraps a settled
   * message to the real column width on every render, including after a terminal resize, so
   * pre-wrapping it here would freeze that message at whatever width it first drew at. With
   * this off, a text block becomes one unbroken line (still carrying its marker and indent)
   * and Ink does the wrapping. Tables and code fences always wrap to `width` regardless — a
   * table's columns and a fence's band are a layout, not running text, and have always been
   * committed at format time (`getTerminalWidth()` inside the legacy formatter's own table
   * layout), so this flag changes nothing for either.
   */
  readonly wrapProse?: boolean;
}

/** Code sits this far inside its band, so it lines up with the prose around it. */
const FENCE_INSET = 2;

interface Paint {
  readonly fg: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly link?: string;
}

function paint(text: string, style: Paint, hyperlinks: boolean): string {
  if (text.length === 0) {
    return text;
  }
  let brush = chalk.hex(style.fg);
  if (style.bg !== undefined) {
    brush = brush.bgHex(style.bg);
  }
  if (style.bold === true) {
    brush = brush.bold;
  }
  if (style.italic === true) {
    brush = brush.italic;
  }
  if (style.underline === true) {
    brush = brush.underline;
  }
  if (style.strikethrough === true) {
    brush = brush.strikethrough;
  }
  const painted = brush(text);
  return hyperlinks && style.link !== undefined
    ? `\u001b]8;;${style.link}\u0007${painted}\u001b]8;;\u0007`
    : painted;
}

/** A wrapped line ends where its last word does; the space the wrapper kept would land in copied text. */
function trimLineEnd(spans: readonly MarkdownSpan[]): MarkdownSpan[] {
  const trimmed = spans.slice();
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last === undefined) {
      break;
    }
    const text = last.text.replace(/\s+$/, "");
    if (text.length > 0) {
      trimmed[trimmed.length - 1] = { ...last, text };
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

function paintSpans(spans: readonly MarkdownSpan[], hyperlinks: boolean): string {
  return spans
    .map((span) => paint(span.text, { ...span, fg: markdownRoleColor(span.role) }, hyperlinks))
    .join("");
}

function spanLine(spans: readonly MarkdownSpan[], hyperlinks: boolean): string {
  return paintSpans(trimLineEnd(spans), hyperlinks);
}

/** Code keeps its indentation, so a long line is cut by cells rather than word-wrapped. */
function codeLines(spans: readonly SyntaxSpan[], width: number): SyntaxSpan[][] {
  const lines: SyntaxSpan[][] = [[]];
  let used = 0;
  for (const span of spans) {
    let rest = span.text;
    while (rest.length > 0) {
      const room = width - used;
      const head = sliceTerminalCells(rest, room);
      if (head.length === 0) {
        lines.push([]);
        used = 0;
        continue;
      }
      lines[lines.length - 1]?.push({ ...span, text: head });
      used += terminalCellWidth(head);
      rest = rest.slice(head.length);
    }
  }
  return lines;
}

interface Layout {
  readonly width: number;
  readonly prose: number;
  readonly syntax: MarkdownSyntax;
  readonly glyphs: GlyphSet;
  readonly hyperlinks: boolean;
  readonly wrapProse: boolean;
}

function textLines(block: Extract<MarkdownBlock, { kind: "text" }>, layout: Layout): string[] {
  const markerWidth = block.marker === undefined ? 0 : terminalCellWidth(block.marker.text);
  const lead = (atFirstLine: boolean): string => {
    if (block.marker === undefined) {
      return " ".repeat(block.indent);
    }
    const markerText =
      atFirstLine || block.repeatMarker === true
        ? paintSpans([block.marker], layout.hyperlinks)
        : " ".repeat(markerWidth);
    return " ".repeat(block.indent) + markerText;
  };
  if (!layout.wrapProse) {
    return [lead(true) + spanLine(block.spans, layout.hyperlinks)];
  }
  const wrapped = wrapStyledSpans(
    block.spans,
    Math.max(1, layout.prose - block.indent - markerWidth),
    sameMarkdownStyle,
  );
  return wrapped.map(
    (line, lineIndex) => lead(lineIndex === 0) + spanLine(line, layout.hyperlinks),
  );
}

function fenceLines(block: Extract<MarkdownBlock, { kind: "fence" }>, layout: Layout): string[] {
  const painted = highlightFenceLines(block.language, block.lines);
  // Without colour a band is only padding, so the fence keeps its markers instead.
  if (layout.syntax === "hybrid" || chalk.level === 0) {
    const muted = { fg: THEME.muted };
    const lines = [paint(block.opener, muted, false)];
    for (const spans of painted) {
      for (const line of codeLines(spans, layout.width)) {
        lines.push(line.map((span) => paint(span.text, { fg: span.fg }, false)).join(""));
      }
    }
    if (block.closed) {
      lines.push(paint("```", muted, false));
    }
    return lines;
  }

  const longest = Math.max(0, ...block.lines.map((line) => terminalCellWidth(line)));
  const bandWidth = Math.min(layout.width, Math.max(layout.prose, longest + FENCE_INSET + 1));
  const inner = Math.max(1, bandWidth - FENCE_INSET - 1);
  const band = THEME.surfaceStrong;
  const row = (content: readonly SyntaxSpan[]): string => {
    const pad = Math.max(0, bandWidth - FENCE_INSET - terminalSegmentsWidth(content));
    return (
      paint(" ".repeat(FENCE_INSET), { fg: THEME.muted, bg: band }, false) +
      content.map((span) => paint(span.text, { fg: span.fg, bg: band }, false)).join("") +
      paint(" ".repeat(pad), { fg: THEME.muted, bg: band }, false)
    );
  };
  const label = sliceTerminalCells(block.language, inner);
  const labelOffset = Math.max(0, inner - terminalCellWidth(label));
  const lines = [
    row(label.length === 0 ? [] : [{ text: " ".repeat(labelOffset) + label, fg: THEME.muted }]),
  ];
  for (const spans of painted) {
    for (const line of codeLines(spans, inner)) {
      lines.push(row(line));
    }
  }
  lines.push(row([]));
  return lines;
}

function tableLines(block: Extract<MarkdownBlock, { kind: "table" }>, layout: Layout): string[] {
  const table = layoutTable(block.rows, block.align, layout.width);
  return table.lines.map((line) => {
    if (line.kind === "cells") {
      return spanLine(line.spans, layout.hyperlinks);
    }
    if (line.kind === "rule") {
      return paint(layout.glyphs.divider.repeat(table.width), { fg: THEME.border }, false);
    }
    return "";
  });
}

function blockLines(block: MarkdownBlock, layout: Layout): string[] {
  switch (block.kind) {
    case "blank":
      return [];
    case "rule":
      return [
        layout.syntax === "hybrid"
          ? paint(block.source, { fg: THEME.muted }, false)
          : paint(layout.glyphs.divider.repeat(layout.prose), { fg: THEME.border }, false),
      ];
    case "heading":
      return layout.wrapProse
        ? wrapStyledSpans(block.spans, layout.prose, sameMarkdownStyle).map((line) =>
            spanLine(line, layout.hyperlinks),
          )
        : [spanLine(block.spans, layout.hyperlinks)];
    case "fence":
      return fenceLines(block, layout);
    case "table":
      return tableLines(block, layout);
    case "text":
      return textLines(block, layout);
  }
}

/**
 * Lay markdown out as terminal lines for Ink and plain output: the same parse
 * and the same spacing rules as the fullscreen transcript. The model's blank
 * lines collapse to one, headings, fences and tables are set off by one blank
 * line, and nothing leads or trails the text.
 */
export function markdownToAnsi(markdown: string, options: AnsiMarkdownOptions): string {
  if (markdown.length === 0) {
    return markdown;
  }
  const glyphs = options.glyphs ?? getGlyphs();
  const syntax = options.syntax ?? "rendered";
  const width = Math.max(1, options.width);
  const layout: Layout = {
    width,
    prose: Math.min(width, PROSE_MEASURE),
    syntax,
    glyphs,
    hyperlinks: options.hyperlinks ?? chalk.level > 0,
    wrapProse: options.wrapProse ?? true,
  };

  const lines: string[] = [];
  let pendingBlank = false;
  let breatheBeforeNext = false;
  const separate = (): void => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };
  for (const block of parseMarkdown(markdown, { glyphs, syntax })) {
    if (block.kind === "blank") {
      pendingBlank = lines.length > 0;
      continue;
    }
    const setOff = block.kind === "heading" || block.kind === "fence" || block.kind === "table";
    if (pendingBlank || breatheBeforeNext || setOff) {
      separate();
    }
    pendingBlank = false;
    breatheBeforeNext = block.kind === "fence" || block.kind === "table";
    lines.push(...blockLines(block, layout));
  }
  if (options.keepEdgeBlankLines === true) {
    if (/^[ \t]*\n/.test(markdown) && lines.length > 0) {
      lines.unshift("");
    }
    if (/\n[ \t]*\n[ \t]*$/.test(markdown)) {
      lines.push("");
    }
  }
  return lines.join("\n");
}
