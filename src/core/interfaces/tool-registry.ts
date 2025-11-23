import { Effect } from "effect";
import type z from "zod";
import type { ToolDefinition, ToolExecutionResult } from "../types/tools";
import type { ConfigService } from "./config";
import type { LoggerService } from "./logger";

export interface ToolCategory {
  readonly id: string;
  readonly displayName: string;
}

export interface ToolExecutionContext {
  readonly agentId: string;
  readonly conversationId?: string;
  readonly userId?: string;
  readonly [key: string]: unknown;
}

export interface Tool<R = never> {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly parameters: z.ZodTypeAny;
  /** If true, this tool is hidden from UI listings (but still usable programmatically). */
  readonly hidden: boolean;
  /**
   * Optional helper for approval-based tools pointing to the follow-up tool name
   * that should be made available once user confirmation is granted.
   */
  readonly approvalExecuteToolName?: string;
  readonly execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, R>;
  /** Optional function to create a summary of the tool execution result */
  readonly createSummary: ((result: ToolExecutionResult) => string | undefined) | undefined;
}

export interface ToolRegistry {
  readonly registerTool: (
    tool: Tool<unknown>,
    category?: ToolCategory,
  ) => Effect.Effect<void, never>;
  readonly registerForCategory: (
    category: ToolCategory,
  ) => (tool: Tool<unknown>) => Effect.Effect<void, never>;
  readonly getTool: (name: string) => Effect.Effect<Tool<unknown>, Error>;
  readonly listTools: () => Effect.Effect<readonly string[], never>;
  readonly getToolDefinitions: () => Effect.Effect<readonly ToolDefinition[], never>;
  readonly listToolsByCategory: () => Effect.Effect<Record<string, readonly string[]>, never>;
  readonly getToolsInCategory: (categoryId: string) => Effect.Effect<readonly string[], never>;
  readonly listCategories: () => Effect.Effect<readonly ToolCategory[], never>;
  readonly executeTool: (
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, ToolRegistry | LoggerService | ConfigService>;
}
