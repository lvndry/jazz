import chalk from "chalk";

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
  formatted = formatEscapedText(formatted);
  formatted = formatCodeBlocks(formatted);
  formatted = formatHeadings(formatted);
  formatted = formatBlockquotes(formatted);
  formatted = formatTaskLists(formatted);
  formatted = formatLists(formatted);
  formatted = formatHorizontalRules(formatted);
  formatted = formatStrikethrough(formatted);
  formatted = formatBold(formatted);
  formatted = formatItalic(formatted);
  formatted = formatInlineCode(formatted);
  formatted = formatLinks(formatted);
  return formatted;
}

function formatEscapedText(text: string): string {
  return text.replace(/\\([*_`\\[\]()#+\-.!])/g, "$1");
}

function formatHeadings(text: string): string {
  let formatted = text;

  // H3: ### Heading (bold blue - less prominent)
  formatted = formatted.replace(/^### (.*)$/gm, (_match, content) => chalk.bold.blue(content));

  // H2: ## Heading (bold blue - prominent)
  formatted = formatted.replace(/^## (.*)$/gm, (_match, content) => chalk.bold.blue(content));

  // H1: # Heading (bold blue underline - most prominent)
  formatted = formatted.replace(/^# (.*)$/gm, (_match, content) => chalk.bold.blue.underline(content));

  return formatted;
}

function formatStrikethrough(text: string): string {
  return text.replace(/~~([^~\n]+?)~~/g, (_match, content) => chalk.strikethrough(content));
}

function formatBold(text: string): string {
  return text.replace(/(\*\*|__)([^*_\n]+?)\1/g, (_match, _delimiter, content) => chalk.bold(content));
}

function formatItalic(text: string): string {
  let formatted = text;

  formatted = formatted.replace(
    /(?<!\*)\*([^*\n]+?)\*(?!\*)/g,
    (_match, content) => chalk.italic(content),
  );

  formatted = formatted.replace(
    /(?<!_)_([^_\n]+?)_(?!_)/g,
    (_match, content) => chalk.italic(content),
  );

  return formatted;
}

function formatInlineCode(text: string): string {
  return text.replace(/`([^`\n]+?)`/g, (_match, code) => chalk.cyan(code));
}

function formatCodeBlocks(text: string): string {
  // Handle code blocks with triple backticks
  // This is a simplified version that works on complete text blocks
  let isInCodeBlock = false;
  const lines = text.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      isInCodeBlock = !isInCodeBlock;
      // Style the code fence itself
      processedLines.push(chalk.yellow(line));
    } else if (isInCodeBlock) {
      // Inside code block - style content as cyan
      processedLines.push(chalk.cyan(line));
    } else {
      processedLines.push(line);
    }
  }

  return processedLines.join("\n");
}

function formatBlockquotes(text: string): string {
  return text.replace(/^\s*>\s+(.+)$/gm, (_match, content) => {
    return chalk.gray(`│ ${content}`);
  });
}

function formatTaskLists(text: string): string {
  // Task list items: - [ ] or - [x] or - [X]
  return text.replace(/^\s*-\s+\[([ xX])\]\s+(.+)$/gm, (_match, checked: string, content: string) => {
    const isChecked = checked.toLowerCase() === "x";
    const checkbox = isChecked ? chalk.green("✓") : chalk.gray("○");
    const indent = "  ";
    return `${indent}${checkbox} ${content}`;
  });
}

function formatLists(text: string): string {
  const lines = text.split("\n");
  const processedLines = lines.map((line) => {
    // Skip if already processed as task list
    if (line.includes("✓") || line.includes("○")) {
      return line;
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

function formatLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, _url) => {
    return chalk.blue.underline(linkText);
  });
}
