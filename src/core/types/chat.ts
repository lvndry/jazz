import type { ChatMessage } from "./message";
import type { ToolCall, ToolDefinition } from "./tools";

export interface ChatCompletionResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  toolsDisabled?: boolean;
  /** Estimated character count of tool definitions sent in this request (for telemetry). */
  toolDefinitionChars?: number;
  /** Number of tool definitions sent in this request (for telemetry). */
  toolDefinitionCount?: number;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  reasoning_effort?: "disable" | "low" | "medium" | "high";
}
