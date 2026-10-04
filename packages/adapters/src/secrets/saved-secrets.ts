import * as nodeFs from "node:fs/promises";
import type { SavedSecretEntry, SavedSecretsService } from "@jazz/core/interfaces/saved-secrets";
import { writeFileDurably } from "@jazz/core/utils/durable-file";
import { withFileLock } from "@jazz/core/utils/file-lock";
import { isRecord } from "@jazz/core/utils/is-record";
import { getSavedSecretsIndexLockPath, getSavedSecretsIndexPath } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringSet,
  type KeyringBackend,
} from "./keyring";

const INDEX_FILE_MODE = 0o600;

/** The keyring account holding one saved secret's value. */
export function savedSecretAccount(name: string): string {
  return `user-secret/${name}`;
}

async function readIndex(): Promise<SavedSecretEntry[]> {
  let raw: string;
  try {
    raw = await nodeFs.readFile(getSavedSecretsIndexPath(), "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  return Object.entries(parsed).flatMap(([name, entry]) =>
    isRecord(entry) && typeof entry["savedAt"] === "string"
      ? [
          {
            name,
            description: typeof entry["description"] === "string" ? entry["description"] : "",
            savedAt: entry["savedAt"],
          },
        ]
      : [],
  );
}

async function writeIndex(entries: readonly SavedSecretEntry[]): Promise<void> {
  const byName = Object.fromEntries(
    [...entries]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => [entry.name, { description: entry.description, savedAt: entry.savedAt }]),
  );
  await writeFileDurably(getSavedSecretsIndexPath(), `${JSON.stringify(byName, null, 2)}\n`, {
    mode: INDEX_FILE_MODE,
  });
}

function updateIndex(
  change: (entries: SavedSecretEntry[]) => SavedSecretEntry[],
): Effect.Effect<boolean> {
  return Effect.tryPromise(() =>
    withFileLock(getSavedSecretsIndexLockPath(), async () => {
      await writeIndex(change(await readIndex()));
    }),
  ).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

/** Saved secrets over Jazz's keyring backends, scoped to the active Jazz home like every other secret. */
export function createSavedSecretsService(
  detectBackend: () => Effect.Effect<KeyringBackend> = detectKeyringBackend,
): SavedSecretsService {
  const backend = Effect.cached(detectBackend()).pipe(Effect.runSync);

  return {
    list: Effect.promise(readIndex),

    read: (name) =>
      Effect.gen(function* () {
        const listed = (yield* Effect.promise(readIndex)).some((entry) => entry.name === name);
        if (!listed) {
          return undefined;
        }
        return yield* keyringGet(yield* backend, savedSecretAccount(name));
      }),

    save: (name, value, description) =>
      Effect.gen(function* () {
        if (value.length === 0) {
          return false;
        }
        const stored = yield* keyringSet(yield* backend, savedSecretAccount(name), value);
        if (!stored) {
          return false;
        }
        const savedAt = new Date().toISOString();
        return yield* updateIndex((entries) => [
          ...entries.filter((entry) => entry.name !== name),
          { name, description, savedAt },
        ]);
      }),

    remove: (name) =>
      Effect.gen(function* () {
        const listed = (yield* Effect.promise(readIndex)).some((entry) => entry.name === name);
        yield* keyringDelete(yield* backend, savedSecretAccount(name));
        if (!listed) {
          return false;
        }
        return yield* updateIndex((entries) => entries.filter((entry) => entry.name !== name));
      }),

    storageDescription: Effect.map(backend, describeKeyringBackend),
  };
}
