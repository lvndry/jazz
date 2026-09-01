/**
 * @fileoverview Finding a webhook's bearer token.
 *
 * Same order as peer tokens: the environment is the deliberate override for a host with no
 * keyring, and the keyring holds it otherwise.
 */

import { Effect } from "effect";
import { detectKeyringBackend, keyringGet } from "@/adapters/secrets/keyring";
import { webhookTokenEnvVar, webhookTokenPath } from "@/adapters/secrets/registry";

export function resolveWebhookToken(webhookName: string): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const fromEnv = process.env[webhookTokenEnvVar(webhookName)];
    if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

    const backend = yield* detectKeyringBackend();
    return yield* keyringGet(backend, webhookTokenPath(webhookName));
  });
}
