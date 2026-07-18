/**
 * Standalone formatting utilities shared between the Ink and CLI rendering paths.
 *
 * These are pure functions (chalk one-liners) that don't require a CLIRenderer
 * instance. Both `InkPresentationService` and `CLIPresentationService` use them
 * directly, avoiding the need to instantiate a full CLIRenderer just for
 * formatting.
 *
 * Tool argument / result formatting is re-exported from the core utility so
 * consumers only need one import.
 */

import chalk from "chalk";
import { Effect } from "effect";
import {
  formatToolArguments as formatToolArgumentsCore,
  formatToolResult as formatToolResultCore,
} from "@/core/utils/tool-formatter";
import { getGlyphs } from "../ui/glyphs";
import { CHALK_THEME } from "../ui/theme";

// ---------------------------------------------------------------------------
// Tool formatting (delegates to core)
// ---------------------------------------------------------------------------

export function formatToolArguments(
  toolName: string,
  args?: Record<string, unknown>,
  options?: { metadata?: Record<string, unknown> },
): string {
  return formatToolArgumentsCore(toolName, args, {
    style: "colored",
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
  });
}

export function formatToolResult(toolName: string, result: string): string {
  return formatToolResultCore(toolName, result);
}

// ---------------------------------------------------------------------------
// Message formatting (pure chalk)
// ---------------------------------------------------------------------------

export function formatThinking(agentName: string, isFirstIteration: boolean = false): string {
  const message = isFirstIteration ? "thinking..." : "processing results...";
  return CHALK_THEME.primary(`${getGlyphs().active}  ${agentName} is ${message}`);
}

export function formatCompletion(agentName: string): string {
  return CHALK_THEME.success(`${getGlyphs().success}  ${agentName} completed successfully`);
}

export function formatWarning(agentName: string, message: string): string {
  return CHALK_THEME.warning(`${getGlyphs().warn}  ${agentName}: ${message}`);
}

export function formatToolExecutionStart(toolName: string, argsStr: string): string {
  return `\n${CHALK_THEME.agent(getGlyphs().arrow)} Executing tool: ${CHALK_THEME.agentBold(toolName)}${CHALK_THEME.agent(argsStr)}...`;
}

export function formatToolExecutionComplete(summary: string | null, durationMs: number): string {
  return ` ${CHALK_THEME.success(getGlyphs().success)}${summary ? ` ${summary}` : ""} ${chalk.dim(`(${durationMs}ms)`)}\n`;
}

export function formatToolExecutionError(errorMessage: string, durationMs: number): string {
  return ` ${CHALK_THEME.error(getGlyphs().error)} ${CHALK_THEME.error(`(${errorMessage})`)} ${chalk.dim(`(${durationMs}ms)`)}\n`;
}

/**
 * Style formatted reasoning for the Static output stream: dim + italic, so it
 * reads as visually distinct from the response while keeping markdown
 * structure intact. Nested markdown re-emits SGR 22 (end-bold, also clears
 * dim) and SGR 23 (end-italic) — re-apply faint and italic after each so the
 * outer styling carries through nested **bold** and *italic* runs.
 */
export function dimReasoningMarkdownOutput(formatted: string): string {
  if (formatted.length === 0) return formatted;
  let patched = formatted;
  // eslint-disable-next-line no-control-regex -- SGR 22 ends bold and clears dim; restore faint after each
  patched = patched.replace(/\x1b\[22m/g, "\x1b[22m\x1b[2m");
  // eslint-disable-next-line no-control-regex -- SGR 23 ends italic; restore italic after each
  patched = patched.replace(/\x1b\[23m/g, "\x1b[23m\x1b[3m");
  return chalk.dim.italic(patched);
}

export function formatToolsDetected(
  agentName: string,
  toolNames: readonly string[],
  toolsRequiringApproval: readonly string[],
): string {
  const approvalSet = new Set(toolsRequiringApproval);
  const formattedTools = toolNames
    .map((name) => {
      if (approvalSet.has(name)) {
        return `${name} ${chalk.dim("(requires approval)")}`;
      }
      return name;
    })
    .join(", ");
  return `\n${CHALK_THEME.warning(getGlyphs().arrow)} ${CHALK_THEME.warning(agentName)} is using tools: ${CHALK_THEME.primary(formattedTools)}\n`;
}

// ---------------------------------------------------------------------------
// Effect-wrapped versions for PresentationService interface conformance
// ---------------------------------------------------------------------------

export function formatThinkingEffect(
  agentName: string,
  isFirstIteration: boolean = false,
): Effect.Effect<string, never> {
  return Effect.sync(() => formatThinking(agentName, isFirstIteration));
}

export function formatCompletionEffect(agentName: string): Effect.Effect<string, never> {
  return Effect.sync(() => formatCompletion(agentName));
}

export function formatWarningEffect(
  agentName: string,
  message: string,
): Effect.Effect<string, never> {
  return Effect.sync(() => formatWarning(agentName, message));
}

export function formatToolExecutionStartEffect(
  toolName: string,
  argsStr: string,
): Effect.Effect<string, never> {
  return Effect.sync(() => formatToolExecutionStart(toolName, argsStr));
}

export function formatToolExecutionCompleteEffect(
  summary: string | null,
  durationMs: number,
): Effect.Effect<string, never> {
  return Effect.sync(() => formatToolExecutionComplete(summary, durationMs));
}

export function formatToolExecutionErrorEffect(
  errorMessage: string,
  durationMs: number,
): Effect.Effect<string, never> {
  return Effect.sync(() => formatToolExecutionError(errorMessage, durationMs));
}

export function formatToolsDetectedEffect(
  agentName: string,
  toolNames: readonly string[],
  toolsRequiringApproval: readonly string[],
): Effect.Effect<string, never> {
  return Effect.sync(() => formatToolsDetected(agentName, toolNames, toolsRequiringApproval));
}
