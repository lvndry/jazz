/**
 * Markdown to ANSI terminal formatting.
 *
 * This module provides a simple interface for converting markdown text
 * to ANSI-formatted terminal output. It delegates to the shared
 * markdown-formatter module for the actual formatting logic.
 */

import { formatMarkdown } from "./markdown-formatter";

/**
 * Apply Markdown formatting heuristics to terminal output.
 * Supports headings (#, ##, ###), bold, italic, strikethrough, inline code, code blocks,
 * links, lists, blockquotes, horizontal rules, task lists, and escaped characters.
 */
export function formatMarkdownAnsi(text: string): string {
  return formatMarkdown(text);
}
