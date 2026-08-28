/**
 * @fileoverview Finding the daemon's own bearer token.
 *
 * Same order as peer and trigger tokens, for the same reason: the environment is the
 * deliberate override (a container has no keyring at all, and someone exporting
 * `JAZZ_DAEMON_TOKEN` on a workstation is doing it on purpose), and the keyring is where the
 * token lives otherwise.
 */

import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { detectKeyringBackend, keyringGet, keyringSet } from "@/adapters/secrets/keyring";
import { DAEMON_TOKEN_ENV_VAR, DAEMON_TOKEN_PATH } from "@/adapters/secrets/registry";

export function resolveDaemonToken(): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const fromEnv = process.env[DAEMON_TOKEN_ENV_VAR];
    if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();

    const backend = yield* detectKeyringBackend();
    return yield* keyringGet(backend, DAEMON_TOKEN_PATH);
  });
}

export interface ProvisionedDaemonToken {
  readonly token: string;
  /** True when this call generated the token rather than finding one already set. */
  readonly generated: boolean;
}

/**
 * `resolveDaemonToken`, but generates and persists a token the first time none exists —
 * rather than making a fresh daemon unusable on a non-loopback host until someone runs
 * `jazz daemon set-token` by hand first. Nobody else needs to independently know this token
 * (unlike a peer's), so Jazz inventing it costs nothing.
 *
 * Returns `undefined` only when there is nowhere safe to keep a generated token: no keyring,
 * and no `$JAZZ_DAEMON_TOKEN` already set. The caller decides what to do in that case; this
 * never writes a token to disk in plaintext.
 */
export function resolveOrProvisionDaemonToken(): Effect.Effect<
  ProvisionedDaemonToken | undefined,
  never
> {
  return Effect.gen(function* () {
    const existing = yield* resolveDaemonToken();
    if (existing !== undefined) return { token: existing, generated: false };

    const backend = yield* detectKeyringBackend();
    if (backend === "none") return undefined;

    const generatedToken = randomBytes(24).toString("hex");
    const stored = yield* keyringSet(backend, DAEMON_TOKEN_PATH, generatedToken);
    if (!stored) return undefined;

    return { token: generatedToken, generated: true };
  });
}
