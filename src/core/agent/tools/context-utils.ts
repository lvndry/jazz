import type { ToolExecutionContext } from "@/core/types";

export function buildKeyFromContext(context: ToolExecutionContext): {
  readonly agentId: string;
  readonly conversationId?: string;
} {
  return context.conversationId
    ? { agentId: context.agentId, conversationId: context.conversationId }
    : { agentId: context.agentId };
}
