/**
 * @fileoverview Finding a peer's bearer token.
 *
 * Two sources, in one order, for both directions of peer traffic. Keeping the lookup in one
 * place matters more than it looks: the caller and the server compare the same secret, and
 * a resolver that disagreed with itself would fail as an authentication error rather than
 * as the configuration mistake it is.
 */

import { Effect } from "effect";
import { detectKeyringBackend, keyringGet } from "@/services/secrets/keyring";
import { peerTokenEnvVar, peerTokenPath } from "@/services/secrets/registry";

/**
 * The environment first, then the keyring.
 *
 * That order because the environment is the deliberate override: a container has no keyring
 * at all, and on a workstation someone exporting a variable is doing it on purpose. The
 * keyring stays the place a token lives when nobody has said otherwise.
 */
export function resolvePeerToken(peerName: string): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const fromEnv = process.env[peerTokenEnvVar(peerName)];
    if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

    const backend = yield* detectKeyringBackend();
    return yield* keyringGet(backend, peerTokenPath(peerName));
  });
}
