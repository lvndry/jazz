/**
 * @fileoverview How much an external caller may reach, as one rule both external doors use.
 *
 * Two doors on this machine answer somebody who is not the operator: a peer's agent asking a
 * question, and a webhook fired by an external system. They are the same authorization
 * question wearing two wire formats — "which of this agent's tools does this caller get?" —
 * and the answer has two independent axes, so it lives here rather than in either door.
 *
 * **Disclosure is a ceiling on read-only tools.** A tier names the {@link ToolDisclosure}
 * level a tool's own answer may carry, so a caller granted `internal` can learn the shape of
 * the machine but never the contents of a file. Enforced by intersecting the toolset down,
 * which means there is nothing outside the tier for a persuasive payload to talk its way
 * into — the model is never offered it.
 *
 * **Anything riskier than read-only or that sends data off-machine needs naming, per caller.**
 * Disclosure says nothing about damage or the request an external caller can cause, so an agent
 * must not hand those tools to every caller just because its disclosure ceiling was raised.
 * An unnamed tool is absent, not merely unapproved.
 */

import { Effect } from "effect";
import {
  ToolRegistryTag,
  type ToolDisclosure,
  type ToolRegistry,
} from "@/core/interfaces/tool-registry";

/**
 * How much an external caller may learn — literally the {@link ToolDisclosure} levels a
 * tool's own answer can carry, plus `none` for a caller granted nothing at all.
 *
 * Not a separate, friendlier vocabulary: the tier a caller holds directly names the
 * disclosure ceiling it admits, so nothing here can be misread as describing risk or
 * permission to act (see the `allow` argument of {@link allowedToolsForTier} for that
 * entirely separate axis).
 */
export type DisclosureTier =
  /** Configured but reaching nothing. What revoking a caller sets. */
  | "none"
  /** Only `public`-disclosure answers: nothing about the operator or their machine. */
  | "public"
  /** Adds `internal`: paths, names, what is installed. Not file contents. */
  | "internal"
  /** Adds `private`, but still read-only. The most an external caller can ever be given. */
  | "private";

export const DISCLOSURE_TIERS: readonly DisclosureTier[] = [
  "none",
  "public",
  "internal",
  "private",
];

export function isDisclosureTier(value: string): value is DisclosureTier {
  return (DISCLOSURE_TIERS as readonly string[]).includes(value);
}

/** What each tier admits among `read-only` tools, as a ceiling on disclosure. */
const TIER_ALLOWS: Readonly<Record<DisclosureTier, readonly ToolDisclosure[]>> = {
  none: [],
  public: ["public"],
  internal: ["public", "internal"],
  private: ["public", "internal", "private"],
};

/** The shape of a registered tool this policy needs, so callers can pass a slice of one. */
export interface TierCandidateTool {
  readonly name: string;
  readonly riskLevel: string;
  readonly disclosure: ToolDisclosure;
  /** Whether calling this tool sends model-authored content beyond this machine. */
  readonly egress: boolean;
}

/**
 * Tools this tier's caller may reach at all.
 *
 * `allow` names tools riskier than read-only or that send data off-machine. Disclosure is
 * silent about both, and an unlisted tool must be absent rather than merely unapproved.
 */
export function allowedToolsForTier(
  tier: string,
  allow: readonly string[],
  tools: readonly TierCandidateTool[],
): readonly string[] {
  // A revoked caller gets nothing, full stop — a standing `allow` grant from before is not a
  // second relationship that survives revocation to `none`. An unrecognized tier lands here
  // too: a typo in a config file must fail closed rather than index `TIER_ALLOWS` with
  // `undefined` and take the whole door down.
  if (!isDisclosureTier(tier) || tier === "none") return [];

  const permitted = TIER_ALLOWS[tier];
  const allowSet = new Set(allow);
  return tools
    .filter((tool) =>
      tool.riskLevel === "read-only" && !tool.egress
        ? permitted.includes(tool.disclosure)
        : allowSet.has(tool.name),
    )
    .map((tool) => tool.name);
}

/**
 * {@link allowedToolsForTier} against the live registry, which is what both doors actually
 * want: the tier and the grant come from config, the risk and disclosure of each tool come
 * from whatever is registered in this process.
 */
export function resolveToolAllowlist(
  tier: string,
  allow: readonly string[],
): Effect.Effect<readonly string[], never, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const names = yield* registry.listTools();
    const described: TierCandidateTool[] = [];
    for (const name of names) {
      const tool = yield* registry.getTool(name).pipe(
        // A name the registry listed but will not hand over cannot be reasoned about, so it
        // is left out rather than admitted unexamined.
        Effect.catchAll(() => Effect.succeed(undefined)),
      );
      if (tool === undefined) continue;
      described.push({
        name,
        riskLevel: tool.riskLevel,
        disclosure: tool.disclosure,
        egress: tool.egress,
      });
    }
    return allowedToolsForTier(tier, allow, described);
  });
}
