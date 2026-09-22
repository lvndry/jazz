/**
 * Resolves conditional memory entries against explicit task dimensions.
 *
 * Memory scope access is enforced before this module runs. This module only decides
 * which already-authorized `when/<topic>/` entries are relevant, keeping relevance
 * separate from disclosure and policy.
 */

import type { MemoryEntryInForce } from "@/core/interfaces/memory-service";

export interface MemoryTaskDimensions {
  readonly medium?: string;
  readonly recipient?: string;
  readonly relationship?: string;
  readonly project?: string;
  readonly persona?: string;
  readonly operation?: string;
  readonly workflow?: readonly string[];
}

export interface RelevantMemoryEntry extends MemoryEntryInForce {
  readonly reason: string;
  readonly specificity: number;
}

/** Derive conservative dimensions from explicit task words; omitted dimensions remain unknown. */
export function inferMemoryTaskDimensions(input: string): MemoryTaskDimensions {
  const text = input.toLowerCase();
  return {
    ...(/\b(email|e-mail)\b/.test(text) ? { medium: "email" } : {}),
    ...(/\b(text|sms|message)\b/.test(text) ? { medium: "text" } : {}),
    ...(/\b(colleague|coworker|client)\b/.test(text) ? { relationship: "colleagues" } : {}),
    ...(/\b(friend|friends)\b/.test(text) ? { relationship: "friends" } : {}),
  };
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dimensionsOf(input: MemoryTaskDimensions): readonly string[] {
  return [
    input.medium,
    input.recipient,
    input.relationship,
    input.project,
    input.persona,
    input.operation,
    ...(input.workflow ?? []),
  ]
    .filter((value): value is string => value !== undefined)
    .flatMap((value) =>
      normalize(value)
        .split("-")
        .filter((part) => part.length > 0),
    );
}

/** Resolve conditional entries with whole-token topic matching and deterministic ordering. */
export function resolveRelevantMemories(
  entries: readonly MemoryEntryInForce[],
  dimensions: MemoryTaskDimensions,
): readonly RelevantMemoryEntry[] {
  const available = new Set(dimensionsOf(dimensions));
  const selected = entries
    .filter((entry) => entry.topic !== undefined)
    .flatMap((entry) => {
      const topic = normalize(entry.topic ?? "");
      if (topic.length === 0) return [];
      const topicParts = topic.split("-").filter((part) => part.length > 0);
      if (topicParts.length === 0 || !topicParts.every((part) => available.has(part))) return [];
      return [
        {
          ...entry,
          reason: `topic ${entry.topic} matched task dimensions`,
          specificity: topicParts.length,
        },
      ];
    });

  return selected.sort(
    (left, right) =>
      right.specificity - left.specificity ||
      left.scope.localeCompare(right.scope) ||
      left.path.localeCompare(right.path),
  );
}
