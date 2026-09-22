/**
 * Resolves conditional memory entries against explicit task dimensions.
 *
 * Dimensions come from a caller that knows them — a messaging bridge knows the
 * medium and the recipient — and are never inferred from the request text.
 * Lexical inference cannot do semantic association and would quietly bias
 * recall toward whichever words it happens to know. Without dimensions no
 * conditional entry is injected, and the agent discovers `when/<topic>/`
 * entries through `view_memory`.
 *
 * Scope access is enforced before this module runs. It only decides which
 * already-authorized entries are relevant, keeping relevance separate from
 * disclosure and policy.
 */

import type { MemoryEntryInForce } from "@/core/interfaces/memory-service";
import { slugifyMemorySegment } from "./entry-path";

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

/**
 * Splits a value the way topic directory names are built, so a dimension and a
 * topic compare token by token: `"Email Colleagues"` and the on-disk
 * `email-colleagues` both become `["email", "colleagues"]`.
 */
function topicTokens(value: string): readonly string[] {
  return slugifyMemorySegment(value)
    .split("-")
    .filter((token) => token.length > 0);
}

function dimensionTokens(dimensions: MemoryTaskDimensions): ReadonlySet<string> {
  return new Set(
    [
      dimensions.medium,
      dimensions.recipient,
      dimensions.relationship,
      dimensions.project,
      dimensions.persona,
      dimensions.operation,
      ...(dimensions.workflow ?? []),
    ]
      .filter((value): value is string => value !== undefined)
      .flatMap(topicTokens),
  );
}

/**
 * Whether a topic applies to the task: every token of the topic must be one of
 * the task's dimensions. Whole tokens, never substrings, so `board` does not
 * fire on `dashboard`, and a compound topic like `email-colleagues` needs both.
 */
export function topicMatchesDimensions(topic: string, dimensions: MemoryTaskDimensions): boolean {
  const available = dimensionTokens(dimensions);
  const tokens = topicTokens(topic);
  return tokens.length > 0 && tokens.every((token) => available.has(token));
}

/**
 * The conditional entries in force for a task, most specific topic first, then
 * by scope and path so the order is stable across runs.
 */
export function resolveRelevantMemories(
  entries: readonly MemoryEntryInForce[],
  dimensions: MemoryTaskDimensions,
): readonly RelevantMemoryEntry[] {
  const selected = entries.flatMap((entry) => {
    if (entry.topic === undefined || !topicMatchesDimensions(entry.topic, dimensions)) {
      return [];
    }
    return [
      {
        ...entry,
        reason: `topic ${entry.topic} matched task dimensions`,
        specificity: topicTokens(entry.topic).length,
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
