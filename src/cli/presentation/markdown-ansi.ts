import chalk from "chalk";

// Placeholder constants using Unicode private use area to avoid markdown conflicts
const CODE_BLOCK_PLACEHOLDER_START = "\uE000";
const CODE_BLOCK_PLACEHOLDER_END = "\uE001";
const INLINE_CODE_PLACEHOLDER_START = "\uE002";
const INLINE_CODE_PLACEHOLDER_END = "\uE003";
const TASK_LIST_MARKER = "\uE004";

/**
 * Strip ANSI escape codes from text
 * Removes all ANSI escape sequences including colors, formatting, and cursor movements
 */
function stripAnsiCodes(text: string): string {
  // Match ANSI escape sequences:
  // ESC[ followed by parameters and ending with m
  // ESC character (0x1B) is matched using character code to avoid linting issues
  const ESC = String.fromCharCode(0x1b);
  const ansiEscapeRegex = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  return text.replace(ansiEscapeRegex, "");
}

/**
 * Normalize excessive blank lines
 * Reduces multiple consecutive blank lines to at most 2 blank lines
 */
function normalizeBlankLines(text: string): string {
  // Replace 3 or more consecutive blank lines with exactly 2 blank lines
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Apply Markdown formatting heuristics to terminal output.
 * Supports headings (#, ##, ###), bold, italic, strikethrough, inline code, code blocks,
 * links, lists, blockquotes, horizontal rules, task lists, and escaped characters.
 */
export function formatMarkdownAnsi(text: string): string {
  if (!text || text.length === 0) {
    return text;
  }

  let formatted = text;
  // Strip ANSI codes first to prevent them from appearing in output
  formatted = stripAnsiCodes(formatted);
  // Normalize excessive blank lines
  formatted = normalizeBlankLines(formatted);
  formatted = formatEscapedText(formatted);

  // Extract code blocks and inline code to protect them from other formatters
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Extract code blocks first (they take precedence)
  formatted = formatted.replace(/```[\s\S]*?```/g, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
  });

  // Extract inline code (but not inside code blocks)
  formatted = formatted.replace(/`([^`\n]+?)`/g, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
  });

  // Apply other formatting to non-code content
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatLinks(formatted);

  // Restore inline code with ANSI formatting
  // Use regex to ensure exact placeholder matching
  inlineCodes.forEach((code, index) => {
    const placeholder = `${INLINE_CODE_PLACEHOLDER_START}${index}${INLINE_CODE_PLACEHOLDER_END}`;
    const regex = new RegExp(escapeRegex(placeholder), "g");
    formatted = formatted.replace(regex, chalk.cyan(code));
  });

  // Restore code blocks with ANSI formatting
  codeBlocks.forEach((block, index) => {
    const placeholder = `${CODE_BLOCK_PLACEHOLDER_START}${index}${CODE_BLOCK_PLACEHOLDER_END}`;
    const regex = new RegExp(escapeRegex(placeholder), "g");
    const formattedBlock = formatCodeBlockContent(block);
    formatted = formatted.replace(regex, formattedBlock);
  });

  return formatted;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove escape characters from markdown escaped text
 */
function formatEscapedText(text: string): string {
  return text.replace(/\\([*_`\\[\]()#+\-.!])/g, "$1");
}

/**
 * Format markdown headings with ANSI colors
 */
function formatHeadings(text: string): string {
  let formatted = text;

  // H3: ### Heading (bold blue - less prominent)
  formatted = formatted.replace(/^### (.*)$/gm, (_match: string, content: string) => chalk.bold.blue(content));

  // H2: ## Heading (bold blue - prominent)
  formatted = formatted.replace(/^## (.*)$/gm, (_match: string, content: string) => chalk.bold.blue(content));

  // H1: # Heading (bold blue underline - most prominent)
  formatted = formatted.replace(/^# (.*)$/gm, (_match: string, content: string) => chalk.bold.blue.underline(content));

  return formatted;
}

/**
 * Format markdown strikethrough text
 */
function formatStrikethrough(text: string): string {
  return text.replace(/~~([^~\n]+?)~~/g, (_match: string, content: string) => chalk.strikethrough(content));
}

/**
 * Format markdown bold text (** or __)
 */
function formatBold(text: string): string {
  return text.replace(/(\*\*|__)([^*_\n]+?)\1/g, (_match: string, _delimiter: string, content: string) => chalk.bold(content));
}

/**
 * Format markdown italic text (* or _)
 */
function formatItalic(text: string): string {
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
 * Format code block content with ANSI colors
 * Preserves leading whitespace while applying colors
 */
function formatCodeBlockContent(codeBlock: string): string {
  // Handle code blocks with triple backticks
  // Format the code fence and content separately
  const lines = codeBlock.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      // Style the code fence itself, preserving indentation
      const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
      const content = line.trimStart();
      processedLines.push(leadingWhitespace + chalk.yellow(content));
    } else {
      // Inside code block - style content as cyan
      processedLines.push(chalk.cyan(line));
    }
  }

  return processedLines.join("\n");
}

/**
 * Format markdown blockquotes with gray color and visual bar
 */
function formatBlockquotes(text: string): string {
  return text.replace(/^\s*>\s+(.+)$/gm, (_match: string, content: string) => {
    return chalk.gray(`│ ${content}`);
  });
}

/**
 * Format markdown task lists with checkboxes
 * Uses a marker to prevent double processing
 */
function formatTaskLists(text: string): string {
  // Task list items: - [ ] or - [x] or - [X]
  return text.replace(/^\s*-\s+\[([ xX])\]\s+(.+)$/gm, (_match: string, checked: string, content: string) => {
    const isChecked = checked.toLowerCase() === "x";
    const checkbox = isChecked ? chalk.green("✓") : chalk.gray("○");
    const indent = "  ";
    // Add marker to prevent reprocessing by formatLists
    return `${TASK_LIST_MARKER}${indent}${checkbox} ${content}`;
  });
}

/**
 * Format markdown lists (ordered and unordered) with colored bullets
 * Supports nested lists with proper indentation
 */
function formatLists(text: string): string {
  const lines = text.split("\n");
  const processedLines = lines.map((line) => {
    // Skip if already processed as task list (contains marker)
    if (line.startsWith(TASK_LIST_MARKER)) {
      // Remove marker and return the formatted task list
      return line.substring(TASK_LIST_MARKER.length);
    }

    // Unordered lists (-, *, +) with nested support
    const unorderedMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (unorderedMatch && unorderedMatch[1] !== undefined && unorderedMatch[2] !== undefined && unorderedMatch[3] !== undefined) {
      const indent = unorderedMatch[1];
      const bullet = unorderedMatch[2];
      const content = unorderedMatch[3];
      const indentLevel = Math.floor(indent.length / 2); // Assume 2 spaces per level
      const indentStr = "  ".repeat(indentLevel + 1);
      return `${indentStr}${chalk.yellow(bullet)} ${content}`;
    }

    // Ordered lists (1., 2., etc.) with nested support
    const orderedMatch = line.match(/^(\s*)(\d+\.)\s+(.+)$/);
    if (orderedMatch && orderedMatch[1] !== undefined && orderedMatch[2] !== undefined && orderedMatch[3] !== undefined) {
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
 * Format markdown horizontal rules with styled line
 * Adapts to terminal width with reasonable limits
 */
function formatHorizontalRules(text: string): string {
  // Get terminal width with fallback
  function getTerminalWidth(): number {
    try {
      return process.stdout.columns || 80;
    } catch {
      return 80;
    }
  }

  const terminalWidth = getTerminalWidth();
  const ruleLength = Math.min(terminalWidth - 4, 40); // Max 40 chars, or terminal width - 4
  const rule = "─".repeat(ruleLength);
  return text.replace(/^\s*([-*_]){3,}\s*$/gm, () => {
    return chalk.gray(rule) + "\n";
  });
}

/**
 * Format markdown links with underlined blue text
 */
function formatLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, linkText: string, _url: string) => {
    return chalk.blue.underline(linkText);
  });
}
