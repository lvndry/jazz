/**
 * @fileoverview Validation for the `jazz run` flags whose values are a closed set.
 *
 * Predicates rather than parsers returning a default: an unrecognised `--approval-policy`
 * is a typo in somebody's cron job, and quietly falling back to a tier they did not ask
 * for is how an unattended run ends up with more authority than intended.
 */

import type { StreamEvent } from "@jazz/core/types/streaming";

const VALID_APPROVAL_POLICIES = ["read-only", "low-risk", "high-risk"] as const;
export type ApprovalPolicyFlag = (typeof VALID_APPROVAL_POLICIES)[number];

export function isApprovalPolicyFlag(value: string): value is ApprovalPolicyFlag {
  return (VALID_APPROVAL_POLICIES as readonly string[]).includes(value);
}

const VALID_REASONING_EFFORTS = ["disable", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

export function isReasoningEffortFlag(value: string): value is ReasoningEffort {
  return (VALID_REASONING_EFFORTS as readonly string[]).includes(value);
}

const VALID_PLATFORMS = ["cli", "telegram", "discord", "github"] as const;
export type PlatformFlag = (typeof VALID_PLATFORMS)[number];

export function isPlatformFlag(value: string): value is PlatformFlag {
  return (VALID_PLATFORMS as readonly string[]).includes(value);
}

const EVENT_CATEGORY_TYPES = {
  tools: ["tools_detected", "tool_call", "tool_execution_start", "tool_execution_complete"],
  reasoning: ["thinking_start", "thinking_chunk", "thinking_complete"],
  text: ["text_start", "text_chunk"],
  usage: ["stream_start", "usage_update", "complete"],
  approval: [
    "approval_required",
    "approval_resolved",
    "command_risk_classifying",
    "command_risk_classified",
  ],
  subagent: ["subagent_start", "subagent_complete"],
} as const satisfies Record<string, readonly StreamEvent["type"][]>;

type EventCategory = keyof typeof EVENT_CATEGORY_TYPES;

function isEventCategory(value: string): value is EventCategory {
  return Object.prototype.hasOwnProperty.call(EVENT_CATEGORY_TYPES, value);
}

/**
 * Parse the comma-separated `--events` flag into the set of `StreamEvent` types
 * to emit. The `error` type is always included so failures surface on the live
 * stream regardless of the selected categories.
 */
export function parseEventCategories(
  raw: string,
): { ok: true; types: ReadonlySet<StreamEvent["type"]> } | { ok: false; error: string } {
  const types = new Set<StreamEvent["type"]>(["error"]);
  const categories = raw
    .split(",")
    .map((category) => category.trim().toLowerCase())
    .filter((category) => category.length > 0);

  for (const category of categories) {
    if (category === "all") {
      for (const eventTypes of Object.values(EVENT_CATEGORY_TYPES)) {
        for (const eventType of eventTypes) {
          types.add(eventType);
        }
      }
      continue;
    }
    if (!isEventCategory(category)) {
      return {
        ok: false,
        error: `Invalid --events category "${category}". Expected: tools, reasoning, text, usage, approval, subagent, all.`,
      };
    }
    for (const eventType of EVENT_CATEGORY_TYPES[category]) {
      types.add(eventType);
    }
  }

  return { ok: true, types };
}

/**
 * Do the selected event types only exist on the streaming path?
 *
 * Reasoning and text deltas are produced by the streaming stream-processor; the batch
 * executor re-routes tool lifecycle events to the renderer but never produces these.
 * Streaming auto-disables when stdout is not a TTY, which is exactly where `--events`
 * consumers live (CI, containers, webhooks) — so a caller asking for these categories
 * there would get a silent tool-only stream. Callers use this to turn streaming back on
 * rather than leave the request unmet.
 */
export function eventsRequireStreaming(types: ReadonlySet<StreamEvent["type"]>): boolean {
  return (
    types.has("thinking_chunk") ||
    types.has("thinking_start") ||
    types.has("thinking_complete") ||
    types.has("text_chunk") ||
    types.has("text_start")
  );
}

/**
 * Resolve a run's streaming mode from the `--stream` / `--no-stream` pair, defaulting to
 * streaming when the requested `--events` categories can only be produced there. An
 * explicit `--no-stream` still wins: the caller is then choosing tool events only.
 *
 * Commander folds `--no-stream` into `stream: false` because a positive `--stream` is
 * declared alongside it, so that is the shape actually seen at runtime; `noStream` is
 * accepted too rather than trusting one library's negation rules to stay put.
 */
export function resolveStreamOption(
  options: { stream?: boolean | undefined; noStream?: boolean | undefined },
  eventCategories: ReturnType<typeof parseEventCategories> | undefined,
): { stream?: boolean } {
  if (options.noStream === true || options.stream === false) return { stream: false };
  if (options.stream === true) return { stream: true };
  if (eventCategories?.ok === true && eventsRequireStreaming(eventCategories.types)) {
    return { stream: true };
  }
  return {};
}
