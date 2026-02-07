import chalk from "chalk";
import { Context, Effect, Layer } from "effect";
import { codeColor } from "@/cli/presentation/code-theme";
import {
  formatMarkdown as formatMarkdownFromFormatter,
  stripAnsiCodes,
  normalizeBlankLines,
  formatEscapedText,
  formatStrikethrough,
  formatBold,
  formatItalic,
  formatInlineCode,
  formatHeadings,
  formatBlockquotes,
  formatTaskLists,
  formatLists,
  formatHorizontalRules,
  formatLinks,
} from "@/cli/presentation/markdown-formatter";

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

// ============================================================================
// Incomplete syntax patterns (unique to streaming — for buffering)
// ============================================================================

const INCOMPLETE_BOLD_REGEX = /\*\*[^*]*$/;
const INCOMPLETE_CODE_REGEX = /`[^`]*$/;
const INCOMPLETE_HEADING_REGEX = /^#+\s*$/m;
const INCOMPLETE_CODE_BLOCK_REGEX = /```[^`]*$/;

// ============================================================================
// Streaming-specific formatting helpers
// ============================================================================

/**
 * Apply inline formatting to a non-code-block text segment.
 */
function applyInlineFormatting(text: string): string {
  let formatted = text;
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
        processedLines.push(codeColor(line));
      } else {
        processedLines.push(line);
      }
    }

    // Check for incomplete syntax at end
    const joined = processedLines.join("\n");
    const { complete, pending } = findIncompleteSyntax(joined);

    // Apply formatting to complete portion (if not in code block)
    const formatted = !isInCodeBlock && complete.length > 0
      ? applyInlineFormatting(complete)
      : complete;

    return {
      formatted,
      pending,
      state: { isInCodeBlock, buffer: pending },
    };
  }

  // If inside code block, just color the text
  if (isInCodeBlock) {
    return {
      formatted: codeColor(fullText),
      pending: "",
      state: { isInCodeBlock, buffer: "" },
    };
  }

  // Check for incomplete syntax
  const { complete, pending } = findIncompleteSyntax(fullText);

  // Apply formatting to complete portion
  const formatted = complete.length > 0
    ? applyInlineFormatting(complete)
    : complete;

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
      const formatted = !state.isInCodeBlock
        ? applyInlineFormatting(pending)
        : codeColor(pending);

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
  format: (text: string) => Effect.sync(() => formatMarkdownFromFormatter(text)),

  createStreamingFormatter: Effect.sync(() => createStreamingFormatterImpl()),

  formatChunk: (text: string, state: StreamingState) =>
    Effect.sync(() => formatStreamingChunk(text, state)),
}));

// ============================================================================
// Convenience Exports (for direct usage without Effect)
// ============================================================================

export {
  formatMarkdownFromFormatter as formatMarkdown,
  formatStreamingChunk,
  stripAnsiCodes,
  normalizeBlankLines,
};
