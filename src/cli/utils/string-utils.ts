/**
 * String and text formatting utilities for CLI output.
 */

/**
 * Get the current terminal width, defaulting to 80 if not available.
 */
export function getTerminalWidth(): number {
  try {
    return process.stdout.columns || 80;
  } catch {
    return 80;
  }
}

/**
 * Strip ANSI escape codes from a string to get its visual width.
 * ANSI escape sequences follow patterns like: \x1b[...m, \u001b[...m, or \033[...m
 * Handles CSI (Control Sequence Introducer) sequences used by chalk and other terminal libraries.
 */
export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Get the visual width of a string, ignoring ANSI escape codes.
 */
export function getVisualWidth(text: string): number {
  return stripAnsiCodes(text).length;
}

/**
 * Pad a string with spaces on the right to reach a target visual width.
 * Handles ANSI escape codes correctly.
 */
export function padRight(text: string, width: number): string {
  const visualWidth = getVisualWidth(text);
  if (visualWidth >= width) return text;
  return text + " ".repeat(width - visualWidth);
}

/**
 * Wrap a comma-separated list of items to fit within a specific width.
 */
export function wrapCommaList(items: readonly string[], width: number): string[] {
  const parts = items.slice();
  const lines: string[] = [];
  let current = "";

  for (const p of parts) {
    const next = current.length === 0 ? p : `${current}, ${p}`;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = p;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Truncate text in the middle, preserving start and end portions.
 * Useful for showing IDs or long paths while keeping recognizable parts.
 *
 * @param text - Text to truncate
 * @param max - Maximum length
 * @returns Truncated text with ellipsis in middle if needed
 */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  if (max <= 10) return text.slice(0, max - 1) + "…";
  const keep = max - 1;
  const left = Math.ceil(keep * 0.6);
  const right = keep - left;
  return text.slice(0, left) + "…" + text.slice(text.length - right);
}

/**
 * Truncate text at the end with ellipsis.
 *
 * @param text - Text to truncate
 * @param max - Maximum length (including ellipsis)
 * @returns Truncated text with ellipsis at end if needed
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return text.slice(0, max - 1) + "…";
}

/**
 * Format a Date to a short ISO-like string: "YYYY-MM-DD HH:MM"
 */
export function formatIsoShort(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Format a provider name for display (e.g., "ai_gateway" → "ai gateway")
 */
export function formatProviderDisplayName(provider: string): string {
  if (provider === "ai_gateway") return "ai gateway";
  return provider;
}

/**
 * Format a list of tools as a summary line.
 *
 * @param tools - List of tool names
 * @param maxWidth - Maximum width for the output
 * @returns Formatted tools summary
 */
export function formatToolsLine(tools: readonly string[] | undefined, maxWidth: number): string {
  const list = tools ?? [];
  if (list.length === 0) return "tools none configured";
  const joined = list.join(", ");
  return truncateMiddle(`tools ${list.length} — ${joined}`, Math.max(20, maxWidth - 2));
}
