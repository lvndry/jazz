// Re-export types from core - core owns the contract, services implement it
export type { ToolDefinition, ToolCall } from "../../core/types/tools";

/**
 * Tool call result (service-specific, not part of core contract)
 */
export interface ToolCallResult {
  toolCallId: string;
  role: "tool";
  name: string;
  content: string;
}

