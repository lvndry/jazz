import chalk from "chalk";

/**
 * Shared markdown formatting utilities for terminal output.
 * Used by both cli-renderer.ts (streaming) and markdown-ansi.ts (static).
 */

// Placeholder constants using Unicode private use area to avoid markdown conflicts
const CODE_BLOCK_PLACEHOLDER_START = "\uE000";
const CODE_BLOCK_PLACEHOLDER_END = "\uE001";
const INLINE_CODE_PLACEHOLDER_START = "\uE002";
const INLINE_CODE_PLACEHOLDER_END = "\uE003";
const TASK_LIST_MARKER = "\uE004";

/**
 * Streaming state for progressive markdown formatting
 */
export interface StreamingState {
  readonly isInCodeBlock: boolean;
}

/**
 * Result of progressive formatting
 */
export interface FormattingResult {
  readonly formatted: string;
  readonly state: StreamingState;
}

/**
 * Initial streaming state
 */
export const INITIAL_STREAMING_STATE: StreamingState = { isInCodeBlock: false };

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip ANSI escape codes from text
 */
export function stripAnsiCodes(text: string): string {
  const ESC = String.fromCharCode(0x1b);
  const ansiEscapeRegex = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  return text.replace(ansiEscapeRegex, "");
}

/**
 * Normalize excessive blank lines (3+ → 2)
 */
export function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Remove escape characters from markdown escaped text
 */
export function formatEscapedText(text: string): string {
  return text.replace(/\\([*_`\\[\]()#+\-.!])/g, "$1");
}

/**
 * Format markdown strikethrough text
 */
export function formatStrikethrough(text: string): string {
  return text.replace(/~~([^~\n]+?)~~/g, (_match: string, content: string) =>
    chalk.strikethrough(content),
  );
}

/**
 * Format markdown bold text (** or __)
 */
export function formatBold(text: string): string {
  return text.replace(/(\*\*|__)([^*_\n]+?)\1/g, (_match: string, _delimiter: string, content: string) =>
    chalk.bold(content),
  );
}

/**
 * Format markdown italic text (* or _)
 */
export function formatItalic(text: string): string {
  let formatted = text;

  formatted = formatted.replace(
    /(?<!\*)\*([^*\n]+?)\*(?!\*)/g,
    (_match: string, content: string) => chalk.italic(content),
  );

  formatted = formatted.replace(
    /(?<!_)_([^_\n]+?)_(?!_)/g,
    (_match: string, content: string) => chalk.italic(content),
  );

  return formatted;
}

/**
 * Format markdown inline code
 */
export function formatInlineCode(text: string): string {
  return text.replace(/`([^`\n]+)`/g, (_match, code) => chalk.cyan(code));
}

/**
 * Format markdown headings with ANSI colors
 */
export function formatHeadings(text: string): string {
  let formatted = text;

  // H4 (####)
  formatted = formatted.replace(/^\s*####\s+(.+)$/gm, (_match, header) => chalk.bold(header));

  // H3 (###)
  formatted = formatted.replace(/^\s*###\s+(.+)$/gm, (_match, header) => chalk.bold.blue(header));

  // H2 (##)
  formatted = formatted.replace(/^\s*##\s+(.+)$/gm, (_match, header) =>
    chalk.bold.blue.underline(header),
  );

  // H1 (#)
  formatted = formatted.replace(/^\s*#\s+(.+)$/gm, (_match, header) =>
    chalk.bold.blue.underline(header),
  );

  return formatted;
}

/**
 * Format markdown blockquotes with gray color and visual bar
 */
export function formatBlockquotes(text: string): string {
  return text.replace(/^\s*>\s+(.+)$/gm, (_match: string, content: string) =>
    chalk.gray(`│ ${content}`),
  );
}

/**
 * Format markdown task lists with checkboxes
 */
export function formatTaskLists(text: string): string {
  return text.replace(
    /^\s*-\s+\[([ xX])\]\s+(.+)$/gm,
    (_match: string, checked: string, content: string) => {
      const isChecked = checked.toLowerCase() === "x";
      const checkbox = isChecked ? chalk.green("✓") : chalk.gray("○");
      const indent = "  ";
      return `${TASK_LIST_MARKER}${indent}${checkbox} ${content}`;
    },
  );
}

/**
 * Format markdown lists (ordered and unordered)
 */
export function formatLists(text: string): string {
  const lines = text.split("\n");
  const processedLines = lines.map((line) => {
    // Skip if already processed as task list
    if (line.startsWith(TASK_LIST_MARKER)) {
      return line.substring(TASK_LIST_MARKER.length);
    }
    // Skip if contains task list markers (already formatted)
    if (line.includes("✓") || line.includes("○")) {
      return line;
    }

    // Unordered lists (-, *, +) with nested support
    const unorderedMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (
      unorderedMatch &&
      unorderedMatch[1] !== undefined &&
      unorderedMatch[2] !== undefined &&
      unorderedMatch[3] !== undefined
    ) {
      const indent = unorderedMatch[1];
      const bullet = unorderedMatch[2];
      const content = unorderedMatch[3];
      const indentLevel = Math.floor(indent.length / 2);
      const indentStr = "  ".repeat(indentLevel + 1);
      return `${indentStr}${chalk.yellow(bullet)} ${content}`;
    }

    // Ordered lists (1., 2., etc.)
    const orderedMatch = line.match(/^(\s*)(\d+\.)\s+(.+)$/);
    if (
      orderedMatch &&
      orderedMatch[1] !== undefined &&
      orderedMatch[2] !== undefined &&
      orderedMatch[3] !== undefined
    ) {
      const indent = orderedMatch[1];
      const number = orderedMatch[2];
      const content = orderedMatch[3];
      const indentLevel = Math.floor(indent.length / 2);
      const indentStr = "  ".repeat(indentLevel + 1);
      return `${indentStr}${chalk.yellow(number)} ${content}`;
    }

    return line;
  });

  return processedLines.join("\n");
}

/**
 * Format markdown horizontal rules
 */
export function formatHorizontalRules(text: string, terminalWidth: number = 80): string {
  const ruleLength = Math.min(terminalWidth - 4, 40);
  const rule = "─".repeat(ruleLength);
  return text.replace(/^\s*([-*_]){3,}\s*$/gm, () => chalk.gray(rule) + "\n");
}

/**
 * Format markdown links with underlined blue text
 */
export function formatLinks(text: string): string {
  return text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match: string, linkText: string, _url: string) => chalk.blue.underline(linkText),
  );
}

/**
 * Format code blocks with stateful tracking
 */
export function formatCodeBlocks(text: string, state: StreamingState): FormattingResult {
  let isInCodeBlock = state.isInCodeBlock;

  if (text.includes("```")) {
    const lines = text.split("\n");
    const processedLines: string[] = [];

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        isInCodeBlock = !isInCodeBlock;
        processedLines.push(chalk.yellow(line));
      } else if (isInCodeBlock) {
        processedLines.push(chalk.cyan(line));
      } else {
        processedLines.push(line);
      }
    }

    return {
      formatted: processedLines.join("\n"),
      state: { isInCodeBlock },
    };
  }

  if (isInCodeBlock) {
    return {
      formatted: chalk.cyan(text),
      state: { isInCodeBlock },
    };
  }

  return { formatted: text, state: { isInCodeBlock } };
}

/**
 * Format code block content (for extracted code blocks)
 */
export function formatCodeBlockContent(codeBlock: string): string {
  const lines = codeBlock.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
      const content = line.trimStart();
      processedLines.push(leadingWhitespace + chalk.yellow(content));
    } else {
      processedLines.push(chalk.cyan(line));
    }
  }

  return processedLines.join("\n");
}

/**
 * Apply progressive formatting for streaming (stateful)
 */
export function applyProgressiveFormatting(text: string, state: StreamingState): FormattingResult {
  if (!text || text.trim().length === 0) {
    return { formatted: text, state };
  }

  // Handle code blocks first (stateful)
  const codeBlockResult = formatCodeBlocks(text, state);
  let formatted = codeBlockResult.formatted;
  const currentState = codeBlockResult.state;

  // If inside a code block, don't apply other formatting
  if (currentState.isInCodeBlock && !text.includes("```")) {
    return { formatted: codeBlockResult.formatted, state: currentState };
  }

  // Apply formatting in order
  formatted = formatEscapedText(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatInlineCode(formatted);
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatLinks(formatted);

  return { formatted, state: currentState };
}

/**
 * Format complete markdown text (stateless, for non-streaming use)
 */
export function formatMarkdown(text: string): string {
  if (!text || text.length === 0) {
    return text;
  }

  let formatted = text;
  formatted = stripAnsiCodes(formatted);
  formatted = normalizeBlankLines(formatted);
  formatted = formatEscapedText(formatted);

  // Extract code blocks and inline code to protect them
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  formatted = formatted.replace(/```[\s\S]*?```/g, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
  });

  formatted = formatted.replace(/`([^`\n]+?)`/g, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
  });

  // Apply formatting
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatLinks(formatted);

  // Restore inline code
  inlineCodes.forEach((code, index) => {
    const placeholder = `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
    const regex = new RegExp(escapeRegex(placeholder), "g");
    formatted = formatted.replace(regex, chalk.cyan(code));
  });

  // Restore code blocks
  codeBlocks.forEach((block, index) => {
    const placeholder = `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
    const regex = new RegExp(escapeRegex(placeholder), "g");
    const formattedBlock = formatCodeBlockContent(block);
    formatted = formatted.replace(regex, formattedBlock);
  });

  return formatted;
}
