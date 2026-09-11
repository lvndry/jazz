/**
 * @fileoverview {@link allowedToolsForTier} applied to the live tool registry.
 *
 * Split out of `./disclosure-tier` rather than sitting beside the policy it applies: that
 * module is reachable from the CLI's Commander tree (via `types/peer`'s tier constants), and
 * this one needs both Effect and the tool-registry interface. Keeping them apart is what
 * keeps ~150ms of module evaluation off the startup path of commands that never open a door
 * — `jazz --version` and `jazz --help` above all.
 */

import { Effect } from "effect";
import { ToolRegistryTag, type ToolRegistry } from "@/core/interfaces/tool-registry";
import { allowedToolsForTier, type TierCandidateTool } from "./disclosure-tier";

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
