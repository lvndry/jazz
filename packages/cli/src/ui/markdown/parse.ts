import { getGlyphs, type GlyphSet } from "../glyphs";
import { parseInlineMarkdown } from "./inline";
import type { MarkdownRole, MarkdownSpan, MarkdownSyntax } from "./spans";
import { terminalCellWidth } from "../text/terminal-cells";

export type TableAlign = "left" | "right" | "center";

/**
 * Markdown as blocks a renderer lays out. Nothing here knows a width or a
 * colour: prose is spans with roles, a table is cells, a fence is its raw
 * lines. Every renderer — the fullscreen transcript, Ink and plain output —
 * reads this same structure, so a parsing fix lands everywhere at once.
 */
export type MarkdownBlock =
  | {
      readonly kind: "text";
      readonly spans: readonly MarkdownSpan[];
      /** Cells of indentation before the marker, for list nesting. */
      readonly indent: number;
      /**
       * A list marker, checkbox or quote bar that opens the first line. Wrapped
       * lines hang under the text after it, or repeat it when `repeatMarker` is set.
       */
      readonly marker?: MarkdownSpan;
      readonly repeatMarker?: boolean;
    }
  | { readonly kind: "heading"; readonly level: number; readonly spans: readonly MarkdownSpan[] }
  | { readonly kind: "blank" }
  | { readonly kind: "rule"; readonly source: string }
  | {
      readonly kind: "fence";
      readonly language: string;
      readonly lines: readonly string[];
      /** The opening line as written, for renderers that keep the syntax visible. */
      readonly opener: string;
      /** False while a streaming answer is still inside the fence. */
      readonly closed: boolean;
    }
  | {
      readonly kind: "table";
      /** The first row is the header. */
      readonly rows: readonly (readonly (readonly MarkdownSpan[])[])[];
      /** From the `| :--- | ---: |` row; a column without one is left-aligned. */
      readonly align: readonly TableAlign[];
    };

export interface ParseOptions {
  readonly glyphs?: GlyphSet;
  readonly syntax?: MarkdownSyntax;
}

/** A list item: its nesting whitespace, its marker, and its text. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** A task list item's checkbox, at the start of the item's text. */
const TASK_BOX = /^\[([ xX])\]\s+(.*)$/;

/** Lines that open a new block, and so end a paragraph or a list item's continuation. */
const BLOCK_START = /^\s*(\||```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/;

/** A top-level list sits this far in from the prose edge, so its marker reads as structure. */
const LIST_INDENT = 2;

const FENCE_OPEN = /^(\s*)```(.*)$/;
const FENCE_CLOSE = /^\s*```/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_LINE = /^\s*\|/;
const TABLE_ALIGN_ROW = /^\|[\s|:-]+\|?$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

function tableCells(raw: string): string[] {
  return raw
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function tableAlign(raw: string): TableAlign[] {
  return tableCells(raw).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) {
      return "center";
    }
    return right ? "right" : "left";
  });
}

/**
 * Headings are ranked by weight and underline, never by hue and never by a
 * glyph: the top level is bold and underlined, the second bold, anything
 * deeper bold secondary text.
 */
function headingSpans(
  text: string,
  level: number,
  glyphs: GlyphSet,
  syntax: MarkdownSyntax,
): MarkdownSpan[] {
  const role: MarkdownRole = level <= 2 ? "text" : "secondary";
  const spans = parseInlineMarkdown(text, role, { glyphs, syntax }).map((span) =>
    span.role === "muted"
      ? span
      : { ...span, bold: true, ...(level <= 1 ? { underline: true } : {}) },
  );
  return syntax === "hybrid" ? [{ text: `${"#".repeat(level)} `, role: "muted" }, ...spans] : spans;
}

function listMarker(
  raw: string,
  checked: boolean | undefined,
  glyphs: GlyphSet,
  syntax: MarkdownSyntax,
): MarkdownSpan {
  const ordered = /^\d/.test(raw);
  if (syntax === "hybrid") {
    const box = checked === undefined ? "" : ` [${checked ? "x" : " "}]`;
    return { text: `${raw}${box} `, role: "muted" };
  }
  if (checked !== undefined) {
    return checked
      ? { text: `${glyphs.todoDone} `, role: "success" }
      : { text: `${glyphs.todoPending} `, role: "muted" };
  }
  return { text: `${ordered ? raw : glyphs.bullet} `, role: "muted" };
}

/**
 * Split markdown into blocks. CommonMark ordered markers (`1.` and `1)`) start
 * a new item even without a blank line, and a paragraph or list item runs on
 * (lazy continuation) until a blank line or the start of another block.
 */
export function parseMarkdown(markdown: string, options: ParseOptions = {}): MarkdownBlock[] {
  const glyphs = options.glyphs ?? getGlyphs();
  const syntax = options.syntax ?? "rendered";
  const inline = (text: string, role: MarkdownRole): MarkdownSpan[] =>
    parseInlineMarkdown(text, role, { glyphs, syntax });
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      blocks.push({ kind: "blank" });
      index += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      // A fence opened inside a list item is indented with it; the body loses
      // that same indentation, as CommonMark reads it, so code starts on the
      // fence's edge instead of floating inside it.
      const opener = (fence[1] ?? "").length;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_CLOSE.test(lines[index] ?? "")) {
        const bodyLine = lines[index] ?? "";
        const leading = bodyLine.length - bodyLine.trimStart().length;
        body.push(bodyLine.slice(Math.min(opener, leading)));
        index += 1;
      }
      const closed = index < lines.length;
      index += 1;
      blocks.push({
        kind: "fence",
        language: (fence[2] ?? "").trim().split(/\s+/)[0] ?? "",
        lines: body,
        opener: line.trim(),
        closed,
      });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule", source: line.trim() });
      index += 1;
      continue;
    }

    if (TABLE_LINE.test(line)) {
      const rows: MarkdownSpan[][][] = [];
      let align: TableAlign[] = [];
      while (index < lines.length && TABLE_LINE.test(lines[index] ?? "")) {
        const raw = (lines[index] ?? "").trim();
        if (TABLE_ALIGN_ROW.test(raw)) {
          align = tableAlign(raw);
        } else {
          const header = rows.length === 0;
          rows.push(
            tableCells(raw).map((cell) =>
              header
                ? inline(cell, "secondary").map((span) =>
                    span.role === "muted" ? span : { ...span, bold: true },
                  )
                : inline(cell, "text"),
            ),
          );
        }
        index += 1;
      }
      blocks.push({ kind: "table", rows, align });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      blocks.push({
        kind: "heading",
        level,
        spans: headingSpans(heading[2] ?? "", level, glyphs, syntax),
      });
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const quoted = [quote[1] ?? ""];
      index += 1;
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index] ?? "");
        if (next === null || (next[1] ?? "").trim().length === 0) {
          break;
        }
        quoted.push((next[1] ?? "").trim());
        index += 1;
      }
      blocks.push({
        kind: "text",
        indent: 0,
        marker:
          syntax === "hybrid"
            ? { text: "> ", role: "muted" }
            : { text: `${glyphs.blockquote} `, role: "border" },
        repeatMarker: true,
        spans: inline(quoted.join(" "), "secondary"),
      });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const depth = Math.floor(terminalCellWidth(item[1] ?? "") / 2);
      const body = [item[3] ?? ""];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (candidate.trim().length === 0 || BLOCK_START.test(candidate)) {
          break;
        }
        body.push(candidate.trim());
        index += 1;
      }
      const text = body.join(" ");
      const task = TASK_BOX.exec(text);
      const checked = task === null ? undefined : (task[1] ?? " ").toLowerCase() === "x";
      blocks.push({
        kind: "text",
        indent: depth * 2 + LIST_INDENT,
        marker: listMarker(item[2] ?? "-", checked, glyphs, syntax),
        spans: inline(task === null ? text : (task[2] ?? ""), "text"),
      });
      continue;
    }

    // The first line is always taken, so a line that looks like a block start
    // but parses as none of them can never stall the loop.
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim().length === 0 || BLOCK_START.test(candidate)) {
        break;
      }
      paragraph.push(candidate.trim());
      index += 1;
    }
    blocks.push({ kind: "text", indent: 0, spans: inline(paragraph.join(" "), "text") });
  }

  return blocks;
}
