/**
 * @fileoverview Finding a webhook's credentials: its bearer token, and the secret its sender
 * signs bodies with.
 *
 * Same order as peer tokens: the environment is the deliberate override for a host with no
 * keyring, and the keyring holds each one otherwise.
 */

import {
  webhookSecretEnvVar,
  webhookSecretPath,
  webhookTokenEnvVar,
  webhookTokenPath,
} from "@jazz/core/secrets/registry";
import { Effect } from "effect";
import { detectKeyringBackend, keyringGet } from "@/adapters/secrets/keyring";

function resolveCredential(envVar: string, keyringPath: string) {
  return Effect.gen(function* () {
    const fromEnv = process.env[envVar];
    if (fromEnv !== undefined && fromEnv.trim().length > 0) {
      return fromEnv.trim();
    }

    const backend = yield* detectKeyringBackend();
    return yield* keyringGet(backend, keyringPath);
  });
}

export function resolveWebhookToken(webhookName: string): Effect.Effect<string | undefined, never> {
  return resolveCredential(webhookTokenEnvVar(webhookName), webhookTokenPath(webhookName));
}

/** The shared secret a `signature` webhook's sender signs each body with. */
export function resolveWebhookSecret(
  webhookName: string,
): Effect.Effect<string | undefined, never> {
  return resolveCredential(webhookSecretEnvVar(webhookName), webhookSecretPath(webhookName));
}
