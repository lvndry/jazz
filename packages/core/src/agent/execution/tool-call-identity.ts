/** Validates the batch identity that binds tool results, approvals and execution ledgers. */
import type { ToolCall } from "@/core/types/tools";

/** Refuses ambiguous provider IDs before any call in a batch can have a side effect. */
export function toolCallIdentityError(calls: readonly ToolCall[]): string | undefined {
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.id.trim().length === 0 || call.function.name.trim().length === 0) {
      return "The model returned a tool call without a nonempty ID or name.";
    }
    if (seen.has(call.id)) {
      return "The model returned duplicate tool call IDs in one batch.";
    }
    seen.add(call.id);
  }
  return undefined;
}
