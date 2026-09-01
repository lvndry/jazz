/**
 * @fileoverview Finding a webhook's bearer token.
 *
 * Same order as peer tokens, for the same reason: the environment is the deliberate override
 * (a container has no keyring at all), and the keyring is where a token lives otherwise.
 *
 * Each source is tried under both the current name and the pre-rename `trigger` one. A token
 * stored before the rename lives in the keyring under `triggers.<name>.token` and nothing
 * migrates it — the keyring is per-machine and jazz never rewrites it on load — so dropping
 * the older name would silently start answering every live webhook with a 401.
 */

import { Effect } from "effect";
import { detectKeyringBackend, keyringGet } from "@/adapters/secrets/keyring";
import {
  legacyTriggerTokenEnvVar,
  legacyTriggerTokenPath,
  webhookTokenEnvVar,
  webhookTokenPath,
} from "@/adapters/secrets/registry";

export function resolveWebhookToken(webhookName: string): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    for (const envVar of [webhookTokenEnvVar(webhookName), legacyTriggerTokenEnvVar(webhookName)]) {
      const fromEnv = process.env[envVar];
      if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
    }

    const backend = yield* detectKeyringBackend();
    for (const path of [webhookTokenPath(webhookName), legacyTriggerTokenPath(webhookName)]) {
      const fromKeyring = yield* keyringGet(backend, path);
      if (fromKeyring !== undefined && fromKeyring.trim().length > 0) return fromKeyring.trim();
    }
    return undefined;
  });
}
