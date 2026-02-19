import chalk from "chalk";
import { Context, Effect, Layer } from "effect";
import {
  formatMarkdown as formatMarkdownFromFormatter,
  stripAnsiCodes,
  normalizeBlankLines,
  formatNonCodeText,
} from "@/cli/presentation/markdown-formatter";
import { codeColor } from "@/cli/ui/theme";

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
  readonly formatChunk: (text: string, state: StreamingState) => Effect.Effect<FormattedChunk>;
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
 *
 * Delegates to the shared {@link formatNonCodeText} pipeline which handles:
 * - inline code extraction (protects `code` from bold/italic corruption)
 * - emoji shortcodes, escape stripping, bold, italic, strikethrough, headings,
 *   blockquotes, lists, horizontal rules
 * - link extraction / bare-URL and file-path formatting / link restoration
 */
const applyInlineFormatting = formatNonCodeText;

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
function formatStreamingChunk(text: string, state: StreamingState): FormattedChunk {
  if (!text || text.trim().length === 0) {
    return { formatted: text, pending: "", state };
  }

  // Prepend any buffered content from previous chunk
  const fullText = state.buffer + text;
  let isInCodeBlock = state.isInCodeBlock;

  // Fast path: entirely inside a code block with no fences in this chunk
  if (isInCodeBlock && !fullText.includes("```")) {
    return {
      formatted: codeColor(fullText),
      pending: "",
      state: { isInCodeBlock, buffer: "" },
    };
  }

  // 1. Process ALL lines to track code block state and separate segments.
  //    Code block state must be updated even for text that will be buffered.
  const lines = fullText.split("\n");
  type Segment = { type: "code" | "text"; lines: string[] };
  const segments: Segment[] = [];
  let current: Segment | null = null;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (current && current.lines.length > 0) segments.push(current);
      segments.push({ type: "code", lines: [chalk.yellow(line)] });
      isInCodeBlock = !isInCodeBlock;
      current = null;
    } else if (isInCodeBlock) {
      if (!current || current.type !== "code") {
        if (current && current.lines.length > 0) segments.push(current);
        current = { type: "code", lines: [] };
      }
      current.lines.push(codeColor(line));
    } else {
      if (!current || current.type !== "text") {
        if (current && current.lines.length > 0) segments.push(current);
        current = { type: "text", lines: [] };
      }
      current.lines.push(line);
    }
  }
  if (current && current.lines.length > 0) segments.push(current);

  // 2. Check the last segment for incomplete syntax (only applies to text
  //    segments — code segments are always "complete" since fences are
  //    tracked statefully).  Run on RAW text so ANSI codes don't interfere.
  let pending = "";
  const lastSeg = segments[segments.length - 1];
  if (lastSeg && lastSeg.type === "text") {
    const rawLast = lastSeg.lines.join("\n");
    const { complete, pending: incompleteTail } = findIncompleteSyntax(rawLast);
    pending = incompleteTail;
    if (complete.length > 0) {
      lastSeg.lines = complete.split("\n");
    } else {
      segments.pop(); // entirely pending — remove from output
    }
  }

  // 3. Format text segments with the full inline pipeline; leave code segments as-is
  const formatted = segments
    .map((seg) =>
      seg.type === "code" ? seg.lines.join("\n") : applyInlineFormatting(seg.lines.join("\n")),
    )
    .join("\n");

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
      const formatted = !state.isInCodeBlock ? applyInlineFormatting(pending) : codeColor(pending);

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
