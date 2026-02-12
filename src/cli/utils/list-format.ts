/**
 * Unified list formatting utilities for consistent CLI output.
 *
 * Provides standardised helpers for rendering headings, grouped lists,
 * key-value pairs, footers, and status indicators across all slash
 * commands (/tools, /skills, /mcp, /agents, /workflows, /help, etc.).
 *
 * Colour usage follows CHALK_THEME:
 *   - Primary (bold) : headings, item names, status badges
 *   - Primary        : section labels, key labels
 *   - Secondary (dim): descriptions, counts, separators, footers
 *   - Bold white     : key values that should stand out
 */

import chalk from "chalk";
import { CHALK_THEME } from "../ui/theme";

// ── Indentation & symbols ────────────────────────────────────────────

const INDENT = "   ";
const ITEM_INDENT = "      ";
const BULLET = "•";
const ARROW = "▸";

// ── Heading ──────────────────────────────────────────────────────────

/**
 * Format a section heading (bold + primary color).
 * The caller is expected to pass this to `terminal.log()`.
 */
export function heading(text: string): string {
  return `\n${CHALK_THEME.heading(text)}\n`;
}

// ── Section / group header ───────────────────────────────────────────

/**
 * Format a group/section header within a list.
 *
 * Example output: `   Git (4 tools):`
 */
export function section(label: string, count?: number, unit?: string): string {
  const countStr =
    count !== undefined && unit
      ? CHALK_THEME.secondary(` (${count} ${count === 1 ? unit : `${unit}s`})`)
      : "";
  return `${INDENT}${CHALK_THEME.primaryBold(label)}${countStr}`;
}

// ── List items ───────────────────────────────────────────────────────

/**
 * Format a simple bullet list item.
 *
 * Example: `      • shell_exec`
 */
export function item(name: string): string {
  return `${ITEM_INDENT}${CHALK_THEME.secondary(BULLET)} ${CHALK_THEME.primary(name)}`;
}

/**
 * Format a bullet list item with a description.
 *
 * Example: `      • git-commit - Commit staged changes`
 */
export function itemWithDesc(name: string, description: string): string {
  return `${ITEM_INDENT}${CHALK_THEME.secondary(BULLET)} ${CHALK_THEME.primary(name)} ${CHALK_THEME.secondary("-")} ${CHALK_THEME.secondary(description)}`;
}

/**
 * Format a labelled list item with an indicator arrow.
 *
 * Example: `   ▸ my-agent (current)`
 */
export function labeledItem(name: string, suffix?: string): string {
  const sfx = suffix ? ` ${CHALK_THEME.secondary(suffix)}` : "";
  return `${INDENT}${CHALK_THEME.primary(ARROW)} ${CHALK_THEME.primaryBold(name)}${sfx}`;
}

/**
 * Format a plain (non-highlighted) labelled item.
 *
 * Example: `     other-agent`
 */
export function labeledItemDim(name: string): string {
  return `${INDENT}  ${CHALK_THEME.white(name)}`;
}

// ── Key-value pairs ──────────────────────────────────────────────────

/**
 * Format an aligned key-value pair.
 *
 * The `width` parameter controls right-padding of the key.
 * Example: `      Model:      openai/gpt-4o`
 */
export function keyValue(key: string, value: string, width = 12): string {
  const paddedKey = `${key}:`.padEnd(width);
  return `${ITEM_INDENT}${CHALK_THEME.secondary(paddedKey)} ${CHALK_THEME.white(value)}`;
}

/**
 * Format a key-value pair with smaller (section) indent.
 *
 * Example: `   Model: openai/gpt-4o`
 */
export function keyValueCompact(key: string, value: string, width = 14): string {
  const paddedKey = `${key}:`.padEnd(width);
  return `${INDENT}${CHALK_THEME.secondary(paddedKey)} ${CHALK_THEME.white(value)}`;
}

// ── Status indicators ────────────────────────────────────────────────

/**
 * Format a connected/active status dot.
 *
 * Example: `   ● my-server`
 */
export function statusConnected(name: string): string {
  return `${INDENT}${chalk.green("●")} ${CHALK_THEME.primaryBold(name)}`;
}

/**
 * Format a disconnected/inactive status dot.
 *
 * Example: `   ○ my-server`
 */
export function statusDisconnected(name: string): string {
  return `${INDENT}${CHALK_THEME.secondary("○")} ${CHALK_THEME.white(name)}`;
}

// ── Footer / totals ──────────────────────────────────────────────────

/**
 * Format a total/footer line.
 *
 * Example: `   Total: 12 tools across 4 categories`
 */
export function footer(text: string): string {
  return `${INDENT}${CHALK_THEME.secondary(text)}`;
}

// ── Help / command listing ───────────────────────────────────────────

/**
 * Format a command + description row for `/help`.
 *
 * Example: `   /tools           List all agent tools by category`
 */
export function commandRow(command: string, description: string, colWidth = 20): string {
  const paddedCmd = command.padEnd(colWidth);
  return `${INDENT}${CHALK_THEME.primaryBold(paddedCmd)}${CHALK_THEME.secondary(description)}`;
}

// ── Utilities ────────────────────────────────────────────────────────

/**
 * Return a blank line string (for use with terminal.log).
 */
export function blank(): string {
  return "";
}

/**
 * Return an "overflow" indicator, e.g. `      ... and 5 more`.
 */
export function overflow(remaining: number): string {
  return `${ITEM_INDENT}${CHALK_THEME.secondary(`... and ${remaining} more`)}`;
}
