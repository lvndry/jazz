import type z from "zod";

/**
 * Tool/Function calling types
 */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: z.ZodTypeAny;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallResult {
  toolCallId: string;
  role: "tool";
  name: string;
  content: string;
}

export interface ToolExecutionResult {
  readonly success: boolean;
  readonly result: unknown;
  readonly error?: string;
}

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
