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
  readonly ok: true;
  readonly token: string;
  /** True when this call generated the token rather than finding one already set. */
  readonly generated: boolean;
}

/**
 * Why provisioning failed, so the caller can explain it precisely rather than just saying
 * "no token" — the two causes point at genuinely different fixes.
 */
export type DaemonTokenProvisionFailure =
  | { readonly ok: false; readonly reason: "no-keyring" }
  | { readonly ok: false; readonly reason: "keyring-write-failed" };

export type ProvisionDaemonTokenResult = ProvisionedDaemonToken | DaemonTokenProvisionFailure;

/**
 * `resolveDaemonToken`, but generates and persists a token the first time none exists —
 * rather than making a fresh daemon unusable on a non-loopback host until someone runs
 * `jazz daemon set-token` by hand first. Nobody else needs to independently know this token
 * (unlike a peer's), so Jazz inventing it costs nothing.
 *
 * Fails only when there is nowhere safe to keep a generated token: no keyring, and no
 * `$JAZZ_DAEMON_TOKEN` already set. The caller decides what to do in that case; this never
 * writes a token to disk in plaintext.
 */
export function resolveOrProvisionDaemonToken(): Effect.Effect<ProvisionDaemonTokenResult, never> {
  return Effect.gen(function* () {
    const existing = yield* resolveDaemonToken();
    if (existing !== undefined) return { ok: true, token: existing, generated: false };

    const backend = yield* detectKeyringBackend();
    if (backend === "none") return { ok: false, reason: "no-keyring" };

    const generatedToken = randomBytes(24).toString("hex");
    const stored = yield* keyringSet(backend, DAEMON_TOKEN_PATH, generatedToken);
    if (!stored) return { ok: false, reason: "keyring-write-failed" };

    return { ok: true, token: generatedToken, generated: true };
  });
}

/**
 * A precise, OS-aware explanation for why provisioning failed, with the one fix that works
 * everywhere (set the token yourself) always given first — the keyring path is a workstation
 * convenience, not the primary mechanism, so it should never be presented as the only way
 * forward.
 */
export function explainDaemonTokenProvisionFailure(
  failure: DaemonTokenProvisionFailure,
  platform: NodeJS.Platform = process.platform,
): string {
  const setItYourself =
    `export ${DAEMON_TOKEN_ENV_VAR}=$(openssl rand -hex 24)\n` +
    `then persist that value yourself — a systemd \`Environment=\` line, your shell profile, ` +
    `or a secrets manager — since nothing else will remember it across restarts.`;

  if (failure.reason === "keyring-write-failed") {
    return (
      `${setItYourself}\n\n` +
      `(A keyring is available but writing the daemon token to it failed — it may be locked ` +
      `or read-only, which is why this is the fix regardless.)`
    );
  }

  const why = (() => {
    switch (platform) {
      case "darwin":
        return (
          `unusual on macOS, since Keychain access ("security") is normally there by default. ` +
          `This can happen with no login keychain unlocked (a sandboxed or CI environment, say).`
        );
      case "linux":
        return (
          `normal for a headless server. The Linux path ("secret-tool") needs a running D-Bus ` +
          `session and a keyring daemon (gnome-keyring or similar), and a server with no ` +
          `desktop login never starts either. Running one just for this isn't worth it either: ` +
          `gnome-keyring normally unlocks itself via PAM at login, which a headless server ` +
          `never triggers, so you'd end up scripting a manual unlock — more operational ` +
          `overhead than the fix above, not less.`
        );
      default:
        return `no keyring backend exists for this platform yet.`;
    }
  })();

  return `${setItYourself}\n\n(No OS keyring is available — ${why})`;
}
