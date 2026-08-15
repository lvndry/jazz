/**
 * One-time migration of the `google` provider name to `gemini`.
 *
 * The provider was renamed to match the model family it actually serves. The
 * name was persisted in agent files and in ~/.jazz/config.json, so stored data
 * is rewritten in place the first time Jazz reads it rather than being kept
 * working through a permanent alias.
 *
 * The AI SDK's own `google` keys (`providerOptions.google`, the
 * `@ai-sdk/google` package, `GOOGLE_GENERATIVE_AI_API_KEY`) are upstream names
 * and are deliberately untouched.
 */

import { Effect } from "effect";

export const LEGACY_PROVIDER_NAME = "google";
export const RENAMED_PROVIDER_NAME = "gemini";

/**
 * Rewrite the provider name wherever an agent record can carry it.
 * Returns the migrated record and whether anything actually changed, so the
 * caller can avoid rewriting files that are already current.
 */
export function migrateAgentProviderName(raw: unknown): { record: unknown; changed: boolean } {
  if (!raw || typeof raw !== "object") return { record: raw, changed: false };

  const record = raw as Record<string, unknown>;
  const config = record["config"];
  if (!config || typeof config !== "object") return { record: raw, changed: false };

  const agentConfig = { ...(config as Record<string, unknown>) };
  let changed = false;

  if (agentConfig["llmProvider"] === LEGACY_PROVIDER_NAME) {
    agentConfig["llmProvider"] = RENAMED_PROVIDER_NAME;
    changed = true;
  }

  const summarizer = agentConfig["summarizerModel"];
  if (typeof summarizer === "string" && summarizer.startsWith(`${LEGACY_PROVIDER_NAME}/`)) {
    agentConfig["summarizerModel"] =
      `${RENAMED_PROVIDER_NAME}/${summarizer.slice(LEGACY_PROVIDER_NAME.length + 1)}`;
    changed = true;
  }

  const apiKeys = agentConfig["llmApiKeys"];
  if (apiKeys && typeof apiKeys === "object" && LEGACY_PROVIDER_NAME in apiKeys) {
    const { [LEGACY_PROVIDER_NAME]: legacyKey, ...rest } = apiKeys as Record<string, unknown>;
    // A key already stored under the new name wins; the legacy one is dropped.
    agentConfig["llmApiKeys"] =
      RENAMED_PROVIDER_NAME in rest ? rest : { ...rest, [RENAMED_PROVIDER_NAME]: legacyKey };
    changed = true;
  }

  if (!changed) return { record: raw, changed: false };
  return { record: { ...record, config: agentConfig }, changed: true };
}

const LEGACY_KEYRING_ACCOUNT = `llm.${LEGACY_PROVIDER_NAME}.api_key`;
const RENAMED_KEYRING_ACCOUNT = `llm.${RENAMED_PROVIDER_NAME}.api_key`;

/**
 * Move a keyring entry stored under the old provider name to the new one.
 *
 * Keyring accounts are named after the config path, so the rename orphans any
 * key stored by an earlier version. The helpers are passed in rather than
 * imported to keep this module free of service dependencies.
 */
export function migrateKeyringProviderName<Backend>(
  backend: Backend,
  get: (backend: Backend, account: string) => Effect.Effect<string | undefined, never>,
  set: (backend: Backend, account: string, secret: string) => Effect.Effect<boolean, never>,
  remove: (backend: Backend, account: string) => Effect.Effect<void, never>,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const legacy = yield* get(backend, LEGACY_KEYRING_ACCOUNT);
    if (legacy === undefined || legacy.trim() === "") return false;

    // Never clobber a key already stored under the new name.
    const existing = yield* get(backend, RENAMED_KEYRING_ACCOUNT);
    if (existing === undefined || existing.trim() === "") {
      const stored = yield* set(backend, RENAMED_KEYRING_ACCOUNT, legacy);
      if (!stored) return false;
    }

    yield* remove(backend, LEGACY_KEYRING_ACCOUNT);
    return true;
  });
}

/**
 * Rewrite `llm.google` to `llm.gemini` in a raw config file record.
 * Returns whether anything changed.
 */
export function migrateConfigProviderName(fileRecord: Record<string, unknown>): boolean {
  const llm = fileRecord["llm"];
  if (!llm || typeof llm !== "object") return false;

  const llmRecord = llm as Record<string, unknown>;
  if (!(LEGACY_PROVIDER_NAME in llmRecord)) return false;

  const { [LEGACY_PROVIDER_NAME]: legacyEntry, ...rest } = llmRecord;
  fileRecord["llm"] =
    RENAMED_PROVIDER_NAME in rest ? rest : { ...rest, [RENAMED_PROVIDER_NAME]: legacyEntry };
  return true;
}
