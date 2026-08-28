/**
 * @fileoverview Finding a webhook trigger's bearer token.
 *
 * Same order as peer tokens, for the same reason: the environment is the deliberate override
 * (a container has no keyring at all), and the keyring is where a token lives otherwise.
 */

import { Effect } from "effect";
import { detectKeyringBackend, keyringGet } from "@/adapters/secrets/keyring";
import { triggerTokenEnvVar, triggerTokenPath } from "@/adapters/secrets/registry";

export function resolveTriggerToken(triggerName: string): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const fromEnv = process.env[triggerTokenEnvVar(triggerName)];
    if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

    const backend = yield* detectKeyringBackend();
    return yield* keyringGet(backend, triggerTokenPath(triggerName));
  });
}
