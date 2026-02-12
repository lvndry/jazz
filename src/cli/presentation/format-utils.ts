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
import { CHALK_THEME } from "../ui/theme";

// ---------------------------------------------------------------------------
// Tool formatting (delegates to core)
// ---------------------------------------------------------------------------

export function formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
  return formatToolArgumentsCore(toolName, args, { style: "colored" });
}

export function formatToolResult(toolName: string, result: string): string {
  return formatToolResultCore(toolName, result);
}

// ---------------------------------------------------------------------------
// Message formatting (pure chalk)
// ---------------------------------------------------------------------------

export function formatThinking(agentName: string, isFirstIteration: boolean = false): string {
  const message = isFirstIteration ? "thinking..." : "processing results...";
  return CHALK_THEME.primary(`🤖  ${agentName} is ${message}`);
}

export function formatCompletion(agentName: string): string {
  return CHALK_THEME.success(`✅  ${agentName} completed successfully`);
}

export function formatWarning(agentName: string, message: string): string {
  return chalk.yellow(`⚠️  ${agentName}: ${message}`);
}

export function formatToolExecutionStart(toolName: string, argsStr: string): string {
  return `\n${CHALK_THEME.primary("▸")} Executing tool: ${CHALK_THEME.primary(toolName)}${argsStr}...`;
}

export function formatToolExecutionComplete(summary: string | null, durationMs: number): string {
  return ` ${CHALK_THEME.success("✓")}${summary ? ` ${summary}` : ""} ${chalk.dim(`(${durationMs}ms)`)}\n`;
}

export function formatToolExecutionError(errorMessage: string, durationMs: number): string {
  return ` ${chalk.red("✗")} ${chalk.red(`(${errorMessage})`)} ${chalk.dim(`(${durationMs}ms)`)}\n`;
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
  return `\n${chalk.yellow("🔧")} ${chalk.yellow(agentName)} is using tools: ${CHALK_THEME.primary(formattedTools)}\n`;
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
