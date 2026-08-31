/**
 * @fileoverview Writing one peer entry into `AppConfig.peers`, without losing the other half.
 *
 * A `PeerConfig` conflates two independent capabilities in one record — `url` (I can ask
 * them) and `may` (they can ask me) — because that is what the config file already looks
 * like today (see `docs/guide/peers-setup.md`). An invite only ever proposes *one* of those
 * two per side. Writing it naively (replace-the-entry-by-name) would silently erase whichever
 * half a previous invite, in the other direction, already established. This is the one
 * function on both the invite-accepting and invite-creating side allowed to touch
 * `AppConfig.peers` at all, so the merge only has to be gotten right once.
 */

import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { PeerConfig, PeerTier } from "@jazz/core/types/peer";
import { Effect } from "effect";

export interface PeerConfigPatch {
  readonly name: string;
  readonly url?: string;
  readonly may?: PeerTier;
  readonly persona?: string;
  readonly allow?: readonly string[];
}

/**
 * Merge one field-level patch into `peers`, by name.
 *
 * A field present in `patch` overwrites; a field absent leaves whatever was already there
 * untouched. So an existing `{ name: "bob", url }` plus a patch of `{ name: "bob", may }`
 * becomes `{ name: "bob", url, may }` — exactly what two one-way invites, run in opposite
 * directions for the same peer, are supposed to compose into.
 */
export function upsertPeer(patch: PeerConfigPatch): Effect.Effect<void, Error, AgentConfigService> {
  return Effect.gen(function* () {
    const configService = yield* AgentConfigServiceTag;
    const revision = yield* configService.revision;
    const appConfig = yield* configService.appConfig;
    const existing = appConfig.peers ?? [];

    const index = existing.findIndex((peer) => peer.name === patch.name);
    const merged: PeerConfig =
      index === -1
        ? {
            name: patch.name,
            ...(patch.url !== undefined ? { url: patch.url } : {}),
            ...(patch.may !== undefined ? { may: patch.may } : {}),
            ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
            ...(patch.allow !== undefined ? { allow: patch.allow } : {}),
          }
        : {
            ...existing[index],
            name: patch.name,
            ...(patch.url !== undefined ? { url: patch.url } : {}),
            ...(patch.may !== undefined ? { may: patch.may } : {}),
            ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
            ...(patch.allow !== undefined ? { allow: patch.allow } : {}),
          };

    const next =
      index === -1
        ? [...existing, merged]
        : existing.map((peer, i) => (i === index ? merged : peer));
    yield* configService.set("peers", next);
    if ((yield* configService.revision) === revision) {
      return yield* Effect.fail(new Error("could not persist peer configuration"));
    }
  });
}
