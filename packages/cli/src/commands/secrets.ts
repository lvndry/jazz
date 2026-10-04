/**
 * `jazz secrets` — secrets saved for every agent on this Jazz home. Agents see names through
 * `list_saved_secrets` and load a value into a run with `use_saved_secret`, which a person
 * approves unless the run allows reading secrets.
 */

import { SavedSecretsServiceTag } from "@jazz/core/interfaces/saved-secrets";
import { readConcealedLine } from "@jazz/core/presentation/concealed-line";
import {
  MAX_USER_SECRET_NAME_LENGTH,
  USER_SECRET_NAME_PATTERN,
} from "@jazz/core/secrets/user-secrets";
import { Effect } from "effect";

function fail(message: string): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function isValidName(name: string): boolean {
  return name.length <= MAX_USER_SECRET_NAME_LENGTH && USER_SECRET_NAME_PATTERN.test(name);
}

export function listSecretsCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const saved = yield* SavedSecretsServiceTag;
    const secrets = yield* saved.list;
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, secrets })}\n`);
      return;
    }
    if (secrets.length === 0) {
      process.stdout.write("No secrets saved. Save one with `jazz secrets set <name>`.\n");
      return;
    }
    for (const secret of secrets) {
      const description = secret.description === "" ? "" : `  ${secret.description}`;
      process.stdout.write(`${secret.name}  saved ${secret.savedAt.slice(0, 10)}${description}\n`);
    }
  });
}

export function setSecretCommand(options: {
  readonly name: string;
  readonly description?: string;
  /** Overridable so a test need not drive a terminal. */
  readonly readSecret?: (prompt: string) => Promise<string | undefined>;
}) {
  return Effect.gen(function* () {
    if (!isValidName(options.name)) {
      return yield* fail(
        `"${options.name}" is not a valid secret name. Use lowercase words joined by hyphens, e.g. cloudflare-token.`,
      );
    }
    const readSecret = options.readSecret ?? ((prompt: string) => readConcealedLine(prompt));
    const value = yield* Effect.promise(() =>
      readSecret(`🔒 Value for ${options.name} (hidden; Esc to cancel): `),
    );
    if (value === undefined || value.length === 0) {
      return yield* fail("Nothing saved.");
    }
    const saved = yield* SavedSecretsServiceTag;
    const stored = yield* saved.save(options.name, value, options.description ?? "");
    const storage = yield* saved.storageDescription;
    if (!stored) {
      return yield* fail(
        `Could not save ${options.name} in ${storage}. Check that the keyring is unlocked and $JAZZ_HOME is writable.`,
      );
    }
    process.stdout.write(`Saved ${options.name} in ${storage}.\n`);
  });
}

export function removeSecretCommand(options: { readonly name: string }) {
  return Effect.gen(function* () {
    const saved = yield* SavedSecretsServiceTag;
    const removed = yield* saved.remove(options.name);
    process.stdout.write(
      removed ? `Forgot ${options.name}.\n` : `No secret was saved as ${options.name}.\n`,
    );
  });
}
