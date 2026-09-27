/**
 * @fileoverview Minting a webhook's credentials: its bearer token, or the secret its sender
 * signs bodies with.
 *
 * Each generates `randomBytes(24)`, stores it in the keyring, and prints it once, the single
 * point at which it is readable, since the sender on the other end needs it and secrets are
 * write-only through `jazz config`. A value already in the credential's environment variable is
 * stored instead of a generated one.
 */

import { randomBytes } from "node:crypto";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  keyringDelete,
  keyringSet,
} from "@jazz/adapters/secrets/keyring";
import {
  webhookSecretEnvVar,
  webhookSecretPath,
  webhookTokenEnvVar,
  webhookTokenPath,
} from "@jazz/adapters/secrets/registry";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";

/** Matches the daemon token: 192 bits. */
const CREDENTIAL_BYTES = 24;

/** One kind of webhook credential, and where each copy of it lives. */
interface WebhookCredential {
  readonly noun: string;
  readonly envVar: (webhookName: string) => string;
  readonly keyringPath: (webhookName: string) => string;
  /** What to tell the operator to do with a freshly printed value. */
  readonly usage: string;
}

const BEARER_TOKEN: WebhookCredential = {
  noun: "token",
  envVar: webhookTokenEnvVar,
  keyringPath: webhookTokenPath,
  usage: "The caller sends it as `Authorization: Bearer <token>` on every request.",
};

const SIGNING_SECRET: WebhookCredential = {
  noun: "signing secret",
  envVar: webhookSecretEnvVar,
  keyringPath: webhookSecretPath,
  usage:
    'Paste it as the webhook secret in the sender (GitHub: Settings > Webhooks > Secret), and set `signature: { "format": "hmac-sha256" }` on the webhook.',
};

function storeCredential(
  credential: WebhookCredential,
  webhookName: string,
): Effect.Effect<void, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const envVar = credential.envVar(webhookName);
    const fromEnv = process.env[envVar];
    const generated = fromEnv === undefined || fromEnv.trim().length === 0;
    const value = generated ? randomBytes(CREDENTIAL_BYTES).toString("hex") : fromEnv.trim();

    const backend = yield* detectKeyringBackend();
    if (backend === "none") {
      yield* terminal.error(
        `$JAZZ_DISABLE_KEYRING is set, so jazz won't store this anywhere. Unset it and run ` +
          `this again, or set ${envVar} yourself wherever the daemon runs.`,
      );
      return;
    }

    const stored = yield* keyringSet(backend, credential.keyringPath(webhookName), value);
    if (!stored) {
      yield* terminal.error(
        `Could not store the ${credential.noun}: neither the OS keyring nor the ` +
          `$JAZZ_HOME/secrets.json fallback could be written to. Check that $JAZZ_HOME is writable.`,
      );
      return;
    }

    const where = describeKeyringBackend(backend);
    yield* terminal.success(
      generated
        ? `Generated a ${credential.noun} for "${webhookName}" and stored it in ${where}.`
        : `Stored the ${credential.noun} for "${webhookName}" in ${where}.`,
    );
    if (generated) {
      yield* terminal.log(`\n  ${value}\n`);
    }
    yield* terminal.info(credential.usage);
    yield* terminal.info(`In a container, supply it as ${envVar} instead.`);
  });
}

function forgetCredential(
  credential: WebhookCredential,
  webhookName: string,
): Effect.Effect<void, never, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const backend = yield* detectKeyringBackend();
    yield* keyringDelete(backend, credential.keyringPath(webhookName));
    yield* terminal.success(`Removed the stored ${credential.noun} for "${webhookName}".`);
  });
}

export function setWebhookTokenCommand(webhookName: string) {
  return storeCredential(BEARER_TOKEN, webhookName);
}

export function forgetWebhookTokenCommand(webhookName: string) {
  return forgetCredential(BEARER_TOKEN, webhookName);
}

export function setWebhookSecretCommand(webhookName: string) {
  return storeCredential(SIGNING_SECRET, webhookName);
}

export function forgetWebhookSecretCommand(webhookName: string) {
  return forgetCredential(SIGNING_SECRET, webhookName);
}
