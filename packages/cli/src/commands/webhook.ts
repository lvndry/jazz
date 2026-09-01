/**
 * @fileoverview Minting a webhook's bearer token.
 *
 * Every other credential jazz uses is generated: the daemon token comes from
 * `randomBytes(24)`, a peer's comes out of the invite flow. A webhook's was the one you had
 * to invent yourself, through the generic `jazz config set`, which has no idea it is being
 * handed a secret. People asked to make up a secret produce `test`, and then it stays — so
 * the fix is to stop asking.
 *
 * Printed once, on purpose. It has to be readable exactly here because the caller on the
 * other end needs it, and `jazz config get` deliberately cannot read secrets back.
 */

import { randomBytes } from "node:crypto";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  keyringDelete,
  keyringSet,
} from "@jazz/adapters/secrets/keyring";
import { webhookTokenEnvVar, webhookTokenPath } from "@jazz/adapters/secrets/registry";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";

/** Matches the daemon token's strength — 192 bits, well past guessing. */
const TOKEN_BYTES = 24;

export function setWebhookTokenCommand(
  webhookName: string,
): Effect.Effect<void, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const envVar = webhookTokenEnvVar(webhookName);
    const fromEnv = process.env[envVar];
    const generated = fromEnv === undefined || fromEnv.trim().length === 0;
    const token = generated ? randomBytes(TOKEN_BYTES).toString("hex") : fromEnv.trim();

    const backend = yield* detectKeyringBackend();
    if (backend === "none") {
      yield* terminal.error(
        `$JAZZ_DISABLE_KEYRING is set, so jazz won't store this anywhere. Unset it and run ` +
          `this again, or set ${envVar} yourself wherever the daemon runs.`,
      );
      return;
    }

    const stored = yield* keyringSet(backend, webhookTokenPath(webhookName), token);
    if (!stored) {
      yield* terminal.error(
        `Could not store the token — neither the OS keyring nor the $JAZZ_HOME/secrets.json ` +
          `fallback could be written to. Check that $JAZZ_HOME is writable.`,
      );
      return;
    }

    yield* terminal.success(
      generated
        ? `Generated a token for "${webhookName}" and stored it in ${describeKeyringBackend(backend)}.`
        : `Stored the token for "${webhookName}" in ${describeKeyringBackend(backend)}.`,
    );
    // The only time it is ever shown. Whoever calls the webhook needs it, and it cannot be
    // read back afterwards.
    yield* terminal.log(`\n  ${token}\n`);
    yield* terminal.info(`In a container, supply it as ${envVar} instead.`);
  });
}

export function forgetWebhookTokenCommand(
  webhookName: string,
): Effect.Effect<void, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const backend = yield* detectKeyringBackend();
    yield* keyringDelete(backend, webhookTokenPath(webhookName));
    yield* terminal.success(`Removed the stored token for "${webhookName}".`);
  });
}
