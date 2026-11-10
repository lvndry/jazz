/**
 * @fileoverview A message body as Telegram rich-message Markdown (Bot API 10.1).
 *
 * Rich messages take GitHub-flavoured Markdown as is, so the model's prose goes out without the
 * conversion to Telegram HTML that the ordinary message path needs, and its tables, headings and
 * task lists render. Two things differ from what a model expects of Markdown, and both are
 * handled here: `$…$` is inline math, and the bridge's own lines are plain text that must not be
 * read as Markdown at all.
 */

import type { RichText, Span } from "@jazz/bot-shared/surface";

/**
 * Telegram's limit is 32768 UTF-8 characters, counted with custom-emoji text and formula
 * source. A JavaScript length counts UTF-16 units, which is never fewer than that, and this
 * margin covers the escapes added after splitting.
 */
export const RICH_MESSAGE_MAX_CHARS = 30_000;

/** Every ASCII character rich Markdown may read as syntax in running text. */
const MARKDOWN_SYNTAX = /[\\`*_[\]<>#|~=$!+\-.()]/g;

/** Plain text, every character of which shows as written. */
export function escapeRichMarkdown(value: string): string {
  return value.replace(MARKDOWN_SYNTAX, (character) => `\\${character}`);
}

function inlineCode(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longestRun + 1);
  // A code span that starts or ends with a backtick needs a space to keep it apart from the fence.
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function renderSpan(span: Span): string {
  switch (span.kind) {
    case "text":
      return escapeRichMarkdown(span.text);
    case "bold":
      return `**${escapeRichMarkdown(span.text)}**`;
    case "code":
      return inlineCode(span.text);
  }
}

/** A fence that opens a code block: up to 3 spaces, then 3 or more backticks or tildes. */
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;
/** A line that is only a fence, which closes an open block of the same kind and length or more. */
const FENCE_ONLY = /^ {0,3}(`+|~+)[ \t]*$/;
const WHITESPACE = /\s/;
const DIGIT = /\d/;

/**
 * Where the inline formula opened by the `$` at `open` closes, or undefined when it is not one.
 *
 * Pandoc's rule, which models write to: the opener is followed by a non-space, and the formula
 * ends at the next unescaped `$` only if that one follows a non-space and is not followed by a
 * digit. "$5 or $10" has no such closer, so both are prices; "$2x + 1$" is a formula.
 */
function formulaCloser(row: string, open: number): number | undefined {
  if (WHITESPACE.test(row[open + 1] ?? " ")) {
    return undefined;
  }
  for (let index = open + 1; index < row.length; index += 1) {
    if (row[index] === "\\") {
      index += 1;
      continue;
    }
    if (row[index] === "$") {
      const closes = !WHITESPACE.test(row[index - 1] ?? " ") && !DIGIT.test(row[index + 1] ?? "");
      return closes ? index : undefined;
    }
  }
  return undefined;
}

/** One line of prose with each price's dollar escaped and every formula left whole. */
function escapePricesInProse(row: string): string {
  let escaped = "";
  let index = 0;
  while (index < row.length) {
    const character = row[index] ?? "";
    if (character === "\\") {
      escaped += row.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character !== "$") {
      escaped += character;
      index += 1;
      continue;
    }
    if (row[index + 1] === "$") {
      const displayEnd = row.indexOf("$$", index + 2);
      const end = displayEnd === -1 ? index + 2 : displayEnd + 2;
      escaped += row.slice(index, end);
      index = end;
      continue;
    }
    const closer = formulaCloser(row, index);
    if (closer !== undefined) {
      escaped += row.slice(index, closer + 1);
      index = closer + 1;
      continue;
    }
    escaped += DIGIT.test(row[index + 1] ?? "") ? "\\$" : "$";
    index += 1;
  }
  return escaped;
}

/**
 * The model's Markdown with every price's dollar sign escaped, so rich Markdown does not open a
 * formula at "$5". Formulas the model wrote stay formulas. Code is left exactly as written:
 * fenced blocks, which close only on a fence of their own kind and length, and inline code spans.
 */
export function escapePrices(markdown: string): string {
  let openFence: { readonly character: string; readonly length: number } | undefined;
  return markdown
    .split("\n")
    .map((row) => {
      if (openFence !== undefined) {
        const closing = FENCE_ONLY.exec(row)?.[1];
        if (
          closing !== undefined &&
          closing[0] === openFence.character &&
          closing.length >= openFence.length
        ) {
          openFence = undefined;
        }
        return row;
      }
      const opening = FENCE_OPENER.exec(row)?.[1];
      if (opening !== undefined) {
        openFence = { character: opening[0] ?? "`", length: opening.length };
        return row;
      }
      return row
        .split(/(`+[^`]*`+)/)
        .map((part, index) => (index % 2 === 1 ? part : escapePricesInProse(part)))
        .join("");
    })
    .join("\n");
}

/** A backtick fence longer than any backtick run in the code, so no line of it can close it. */
function fencedBlock(value: string, language: string | undefined): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language ?? ""}\n${value}\n${fence}`;
}

/**
 * The body as one rich-Markdown document. Every block is its own paragraph, and an empty line
 * block, which only spaces the others apart, is dropped.
 */
export function toRichMarkdown(body: RichText): string {
  return body
    .map((block) => {
      switch (block.kind) {
        case "markdown":
          return escapePrices(block.text);
        case "line":
        case "subtle":
          return block.spans.map(renderSpan).join("");
        case "codeBlock":
          return fencedBlock(block.text, block.language);
        case "quote":
          return block.text
            .split("\n")
            .map((row) => `>${escapeRichMarkdown(row)}`)
            .join("\n");
      }
    })
    .filter((rendered) => rendered.trim().length > 0)
    .join("\n\n");
}
