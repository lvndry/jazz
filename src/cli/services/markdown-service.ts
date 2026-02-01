import chalk from "chalk";
import { Context, Effect, Layer } from "effect";

// ============================================================================
// Types
// ============================================================================

/**
 * Streaming state for progressive markdown formatting.
 */
export interface StreamingState {
  readonly isInCodeBlock: boolean;
  readonly buffer: string;
}

/**
 * Result of formatting a chunk of text.
 */
export interface FormattedChunk {
  /** Formatted text ready for display */
  readonly formatted: string;
  /** Text that was buffered (incomplete syntax) */
  readonly pending: string;
  /** Updated streaming state */
  readonly state: StreamingState;
}

/**
 * Streaming formatter instance.
 */
export interface StreamingFormatter {
  /** Append text chunk and get formatted output */
  readonly append: (chunk: string) => Effect.Effect<FormattedChunk>;
  /** Flush any pending content */
  readonly flush: Effect.Effect<string>;
  /** Reset formatter state */
  readonly reset: Effect.Effect<void>;
  /** Get current state */
  readonly getState: Effect.Effect<StreamingState>;
}

/**
 * Markdown service interface.
 */
export interface MarkdownService {
  /** Format complete markdown text (stateless) */
  readonly format: (text: string) => Effect.Effect<string>;

  /** Create a streaming formatter instance */
  readonly createStreamingFormatter: Effect.Effect<StreamingFormatter>;

  /** Format a single chunk with provided state (low-level) */
  readonly formatChunk: (
    text: string,
    state: StreamingState,
  ) => Effect.Effect<FormattedChunk>;
}

export const MarkdownServiceTag = Context.GenericTag<MarkdownService>("MarkdownService");

// ============================================================================
// Constants
// ============================================================================

/** Initial state for streaming formatter */
export const INITIAL_STREAMING_STATE: StreamingState = {
  isInCodeBlock: false,
  buffer: "",
};

// Placeholder constants using Unicode private use area
const CODE_BLOCK_PLACEHOLDER_START = "\uE000";
const CODE_BLOCK_PLACEHOLDER_END = "\uE001";
const INLINE_CODE_PLACEHOLDER_START = "\uE002";
const INLINE_CODE_PLACEHOLDER_END = "\uE003";
const TASK_LIST_MARKER = "\uE004";

// ============================================================================
// Pre-compiled Regexes (Performance Optimization)
// ============================================================================

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*m/g;
const BLANK_LINES_REGEX = /\n{3,}/g;
const ESCAPED_TEXT_REGEX = /\\([*_`\\[\]()#+\-.!])/g;
const STRIKETHROUGH_REGEX = /~~([^~\n]+?)~~/g;
const BOLD_REGEX = /(\*\*|__)([^*_\n]+?)\1/g;
const ITALIC_ASTERISK_REGEX = /(?<!\*)\*([^*\n]+?)\*(?!\*)/g;
const ITALIC_UNDERSCORE_REGEX = /(?<!_)_([^_\n]+?)_(?!_)/g;
const INLINE_CODE_REGEX = /`([^`\n]+)`/g;
const H4_REGEX = /^\s*####\s+(.+)$/gm;
const H3_REGEX = /^\s*###\s+(.+)$/gm;
const H2_REGEX = /^\s*##\s+(.+)$/gm;
const H1_REGEX = /^\s*#\s+(.+)$/gm;
const BLOCKQUOTE_REGEX = /^\s*>\s+(.+)$/gm;
const TASK_LIST_REGEX = /^\s*-\s+\[([ xX])\]\s+(.+)$/gm;
const HORIZONTAL_RULE_REGEX = /^\s*([-*_]){3,}\s*$/gm;
// eslint-disable-next-line no-control-regex
const LINK_REGEX = /(?<!\u001b)\[([^\]]+)\]\(([^)]+)\)/g;
const CODE_BLOCK_EXTRACT_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_EXTRACT_REGEX = /`([^`\n]+?)`/g;

// Incomplete syntax patterns (for buffering)
const INCOMPLETE_BOLD_REGEX = /\*\*[^*]*$/;
const INCOMPLETE_CODE_REGEX = /`[^`]*$/;
const INCOMPLETE_HEADING_REGEX = /^#+\s*$/m;
const INCOMPLETE_CODE_BLOCK_REGEX = /```[^`]*$/;

// ============================================================================
// Formatting Functions
// ============================================================================

function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

function normalizeBlankLines(text: string): string {
  return text.replace(BLANK_LINES_REGEX, "\n\n");
}

function formatEscapedText(text: string): string {
  return text.replace(ESCAPED_TEXT_REGEX, "$1");
}

function formatStrikethrough(text: string): string {
  return text.replace(STRIKETHROUGH_REGEX, (_match: string, content: string) =>
    chalk.strikethrough(content),
  );
}

function formatBold(text: string): string {
  return text.replace(BOLD_REGEX, (_match: string, _delimiter: string, content: string) =>
    chalk.bold(content),
  );
}

function formatItalic(text: string): string {
  let formatted = text;
  formatted = formatted.replace(
    ITALIC_ASTERISK_REGEX,
    (_match: string, content: string) => chalk.italic(content),
  );
  formatted = formatted.replace(
    ITALIC_UNDERSCORE_REGEX,
    (_match: string, content: string) => chalk.italic(content),
  );
  return formatted;
}

function formatInlineCode(text: string): string {
  return text.replace(INLINE_CODE_REGEX, (_match, code) => chalk.cyan(code));
}

function formatHeadings(text: string): string {
  let formatted = text;
  formatted = formatted.replace(H4_REGEX, (_match, header) => chalk.bold(header));
  formatted = formatted.replace(H3_REGEX, (_match, header) => chalk.bold.blue(header));
  formatted = formatted.replace(H2_REGEX, (_match, header) =>
    chalk.bold.blue.underline(header),
  );
  formatted = formatted.replace(H1_REGEX, (_match, header) =>
    chalk.bold.blue.underline(header),
  );
  return formatted;
}

function formatBlockquotes(text: string): string {
  return text.replace(BLOCKQUOTE_REGEX, (_match: string, content: string) =>
    chalk.gray(`│ ${content}`),
  );
}

function formatTaskLists(text: string): string {
  return text.replace(
    TASK_LIST_REGEX,
    (_match: string, checked: string, content: string) => {
      const isChecked = checked.toLowerCase() === "x";
      const checkbox = isChecked ? chalk.green("✓") : chalk.gray("○");
      const indent = "  ";
      return `${TASK_LIST_MARKER}${indent}${checkbox} ${content}`;
    },
  );
}

function formatLists(text: string): string {
  const lines = text.split("\n");
  const processedLines = lines.map((line) => {
    // Skip if already processed as task list
    if (line.startsWith(TASK_LIST_MARKER)) {
      return line.substring(TASK_LIST_MARKER.length);
    }
    if (line.includes("✓") || line.includes("○")) {
      return line;
    }

    // Unordered lists
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

    // Ordered lists
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

function formatHorizontalRules(text: string, terminalWidth: number = 80): string {
  const ruleLength = Math.min(terminalWidth - 4, 40);
  const rule = "─".repeat(ruleLength);
  return text.replace(HORIZONTAL_RULE_REGEX, () => chalk.gray(rule) + "\n");
}

function formatLinks(text: string): string {
  return text.replace(LINK_REGEX, (_match: string, linkText: string, _url: string) =>
    chalk.blue.underline(linkText),
  );
}

function formatCodeBlockContent(codeBlock: string): string {
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

// ============================================================================
// Core Formatting Logic
// ============================================================================

/**
 * Format complete markdown text (stateless).
 */
function formatCompleteMarkdown(text: string): string {
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

  formatted = formatted.replace(CODE_BLOCK_EXTRACT_REGEX, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
  });

  formatted = formatted.replace(INLINE_CODE_EXTRACT_REGEX, (_match, code: string) => {
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
  for (let index = 0; index < inlineCodes.length; index++) {
    const placeholder = `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
    formatted = formatted.replace(placeholder, chalk.cyan(inlineCodes[index]!));
  }

  // Restore code blocks
  for (let index = 0; index < codeBlocks.length; index++) {
    const placeholder = `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
    const formattedBlock = formatCodeBlockContent(codeBlocks[index]!);
    formatted = formatted.replace(placeholder, formattedBlock);
  }

  return formatted;
}

/**
 * Check if text ends with incomplete syntax that should be buffered.
 */
function findIncompleteSyntax(text: string): { complete: string; pending: string } {
  // Check for incomplete code block (```)
  if (INCOMPLETE_CODE_BLOCK_REGEX.test(text)) {
    const match = text.match(INCOMPLETE_CODE_BLOCK_REGEX);
    if (match && match.index !== undefined) {
      return {
        complete: text.slice(0, match.index),
        pending: text.slice(match.index),
      };
    }
  }

  // Check for incomplete inline code
  if (INCOMPLETE_CODE_REGEX.test(text)) {
    const match = text.match(INCOMPLETE_CODE_REGEX);
    if (match && match.index !== undefined) {
      return {
        complete: text.slice(0, match.index),
        pending: text.slice(match.index),
      };
    }
  }

  // Check for incomplete bold
  if (INCOMPLETE_BOLD_REGEX.test(text)) {
    const match = text.match(INCOMPLETE_BOLD_REGEX);
    if (match && match.index !== undefined) {
      return {
        complete: text.slice(0, match.index),
        pending: text.slice(match.index),
      };
    }
  }

  // Check for incomplete heading at end of text
  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  if (INCOMPLETE_HEADING_REGEX.test(lastLine)) {
    return {
      complete: lines.slice(0, -1).join("\n"),
      pending: lastLine,
    };
  }

  return { complete: text, pending: "" };
}

/**
 * Format a streaming chunk with state tracking.
 */
function formatStreamingChunk(
  text: string,
  state: StreamingState,
): FormattedChunk {
  if (!text || text.trim().length === 0) {
    return { formatted: text, pending: "", state };
  }

  // Prepend any buffered content from previous chunk
  const fullText = state.buffer + text;
  let isInCodeBlock = state.isInCodeBlock;

  // Handle code block state
  if (fullText.includes("```")) {
    const lines = fullText.split("\n");
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

    // Check for incomplete syntax at end
    const joined = processedLines.join("\n");
    const { complete, pending } = findIncompleteSyntax(joined);

    // Apply formatting to complete portion (if not in code block)
    let formatted = complete;
    if (!isInCodeBlock && complete.length > 0) {
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
    }

    return {
      formatted,
      pending,
      state: { isInCodeBlock, buffer: pending },
    };
  }

  // If inside code block, just color the text
  if (isInCodeBlock) {
    return {
      formatted: chalk.cyan(fullText),
      pending: "",
      state: { isInCodeBlock, buffer: "" },
    };
  }

  // Check for incomplete syntax
  const { complete, pending } = findIncompleteSyntax(fullText);

  // Apply formatting to complete portion
  let formatted = complete;
  if (complete.length > 0) {
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
  }

  return {
    formatted,
    pending,
    state: { isInCodeBlock, buffer: pending },
  };
}

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Create a streaming formatter instance.
 */
function createStreamingFormatterImpl(): StreamingFormatter {
  let state: StreamingState = INITIAL_STREAMING_STATE;

  return {
    append: (chunk: string) =>
      Effect.sync(() => {
        const result = formatStreamingChunk(chunk, state);
        state = result.state;
        return result;
      }),

    flush: Effect.sync(() => {
      const pending = state.buffer;
      if (pending.length === 0) {
        return "";
      }

      // Format any remaining buffered content
      let formatted = pending;
      if (!state.isInCodeBlock) {
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
      } else {
        formatted = chalk.cyan(formatted);
      }

      state = INITIAL_STREAMING_STATE;
      return formatted;
    }),

    reset: Effect.sync(() => {
      state = INITIAL_STREAMING_STATE;
    }),

    getState: Effect.sync(() => state),
  };
}

// ============================================================================
// Layer
// ============================================================================

/**
 * Markdown Service Layer.
 */
export const MarkdownServiceLive = Layer.sync(MarkdownServiceTag, () => ({
  format: (text: string) => Effect.sync(() => formatCompleteMarkdown(text)),

  createStreamingFormatter: Effect.sync(() => createStreamingFormatterImpl()),

  formatChunk: (text: string, state: StreamingState) =>
    Effect.sync(() => formatStreamingChunk(text, state)),
}));

// ============================================================================
// Convenience Exports (for direct usage without Effect)
// ============================================================================

export {
  formatCompleteMarkdown as formatMarkdown,
  formatStreamingChunk,
  stripAnsiCodes,
  normalizeBlankLines,
};
