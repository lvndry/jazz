import { type ToolExecutionContext } from "./tool-registry";

export function buildKeyFromContext(context: ToolExecutionContext): {
  readonly agentId: string;
  readonly conversationId?: string;
} {
  return context.conversationId
    ? { agentId: context.agentId, conversationId: context.conversationId }
    : { agentId: context.agentId };
}
