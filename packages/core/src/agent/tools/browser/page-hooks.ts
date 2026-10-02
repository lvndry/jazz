/**
 * Applies the advisory page hooks to a snapshot. Both hooks are optional and advisory: with no
 * plugin, or when a plugin errors, times out, or abstains, the result is exactly the snapshot
 * Jazz would show without them, plus the flags read from the page's own structure.
 */

import { Effect } from "effect";
import {
  MAX_ROUTE_REQUEST_CHARS,
  type PageFlagId,
  type PageStructuralSignals,
  type RouteSnapshotOutcome,
} from "@/core/types/plugin";
import type { ToolExecutionContext } from "@/core/types/tools";
import {
  combineFlags,
  describeFlags,
  flagsFromClassification,
  summarizeElements,
} from "./page-signals";
import type { PageState } from "./session";
import { snapshotWindow, type PageSnapshot } from "./snapshot";

/**
 * A routed element leads the snapshot at or above this probability. The routing answer spreads one
 * unit of probability over every element, so several relevant elements each hold a modest share;
 * a low bar keeps them all, and a wrong inclusion only costs a line of attention.
 */
export const ROUTE_SNAPSHOT_MIN_PROBABILITY = 0.1;

/** The most elements the lead section lists, so it stays a pointer and not a second outline. */
export const ROUTE_SNAPSHOT_MAX_LEAD = 8;

const REF_SUFFIX = /\[ref=(e\d+)\]\s*$/;

export interface PageAdvice {
  readonly flags: readonly PageFlagId[];
  /** Refs the routing put first, most relevant first. Empty when nothing was routed. */
  readonly leadRefs: readonly string[];
}

function latestUserRequest(context: ToolExecutionContext): string {
  const messages = context.conversationMessages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content.slice(0, MAX_ROUTE_REQUEST_CHARS);
    }
  }
  return "";
}

function leadRefsFrom(outcome: RouteSnapshotOutcome): readonly string[] {
  if (outcome.status !== "answered") {
    return [];
  }
  return outcome.distribution.elements
    .filter(({ probability }) => probability >= ROUTE_SNAPSHOT_MIN_PROBABILITY)
    .sort((left, right) => right.probability - left.probability)
    .slice(0, ROUTE_SNAPSHOT_MAX_LEAD)
    .map(({ ref }) => ref);
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The flags and the routed refs for one snapshot. The hooks run together. Routing runs only for
 * the first window of a snapshot, because a continuation shows later lines of the same outline.
 */
export function advisePage(
  context: ToolExecutionContext,
  input: {
    readonly page: PageState & { readonly snapshot: PageSnapshot };
    readonly signals: PageStructuralSignals;
    readonly firstWindow: boolean;
  },
): Effect.Effect<PageAdvice> {
  return Effect.gen(function* () {
    const origin = originOf(input.page.url);
    const elements = summarizeElements(input.page.snapshot.refs);
    if (origin === undefined) {
      return { flags: combineFlags(input.signals, []), leadRefs: [] };
    }
    const classify = context.classifyPage;
    const route = context.routeSnapshot;
    const [classification, routing] = yield* Effect.all(
      [
        classify === undefined
          ? Effect.succeed(undefined)
          : classify({ origin, title: input.page.title, elements, signals: input.signals }),
        route === undefined || !input.firstWindow || elements.length === 0
          ? Effect.succeed(undefined)
          : route({ requestText: latestUserRequest(context), origin, elements }),
      ],
      { concurrency: 2 },
    );
    return {
      flags: combineFlags(input.signals, flagsFromClassification(classification)),
      leadRefs: routing === undefined ? [] : leadRefsFrom(routing),
    };
  });
}

/**
 * The snapshot text for the model: the lines of the routed elements first, then the whole outline
 * untouched. Routing reorders attention and removes nothing.
 */
function leadSection(snapshot: PageSnapshot, leadRefs: readonly string[]): string | undefined {
  if (leadRefs.length === 0) {
    return undefined;
  }
  const lineByRef = new Map<string, string>();
  for (const line of snapshot.lines) {
    const ref = REF_SUFFIX.exec(line)?.[1];
    if (ref !== undefined) {
      lineByRef.set(ref, line.trim());
    }
  }
  const lines = leadRefs.flatMap((ref) => {
    const line = lineByRef.get(ref);
    return line === undefined ? [] : [`  ${line}`];
  });
  return lines.length === 0 ? undefined : ["Likely relevant to your request:", ...lines].join("\n");
}

/** The body of a browser_snapshot result: warning, routed lead, then the outline window. */
export function renderSnapshot(
  snapshot: PageSnapshot,
  advice: PageAdvice,
  startLine: number | undefined,
): string {
  const warning = describeFlags(advice.flags);
  const lead = leadSection(snapshot, advice.leadRefs);
  const outline = snapshotWindow(snapshot, startLine).text;
  return [warning, lead, outline].filter((part) => part !== undefined).join("\n\n");
}
