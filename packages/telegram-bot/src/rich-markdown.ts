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

/** A dollar sign right before a digit is a price, and rich Markdown would open a formula there. */
const PRICE_DOLLAR = /\$(?=\d)/g;
const CODE_FENCE_LINE = /^\s*(```|~~~)/;

/**
 * The model's Markdown with every price's dollar sign escaped. Code is left exactly as written:
 * fenced blocks and inline code spans, where a backslash would show.
 */
export function escapePrices(markdown: string): string {
  let insideFence = false;
  return markdown
    .split("\n")
    .map((row) => {
      if (CODE_FENCE_LINE.test(row)) {
        insideFence = !insideFence;
        return row;
      }
      if (insideFence) {
        return row;
      }
      return row
        .split(/(`+[^`]*`+)/)
        .map((part, index) => (index % 2 === 1 ? part : part.replace(PRICE_DOLLAR, "\\$")))
        .join("");
    })
    .join("\n");
}

function fencedBlock(value: string, language: string | undefined): string {
  const fence = value.includes("```") ? "~~~" : "```";
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
