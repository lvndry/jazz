import type { ModelMessage } from "ai";
import type { JsonValue, StoredReasoningPart } from "@/core/types/message";

interface ReasoningLikePart {
  type: string;
  text?: string;
  providerOptions?: Record<string, Record<string, JsonValue>>;
}

export function extractReasoningParts(
  responseMessages: ReadonlyArray<ModelMessage>,
  providerName: string,
): StoredReasoningPart[] | undefined {
  const collected: StoredReasoningPart[] = [];

  for (const message of responseMessages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const part of message.content as ReadonlyArray<ReasoningLikePart>) {
      if (part.type !== "reasoning") continue;
      const hasText = typeof part.text === "string" && part.text.length > 0;
      const hasPayload = part.providerOptions != null;
      if (!hasText && !hasPayload) continue;

      collected.push({
        text: part.text ?? "",
        provider: providerName,
        ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
      });
    }
  }

  return collected.length > 0 ? collected : undefined;
}
