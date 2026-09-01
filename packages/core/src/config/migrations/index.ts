/**
 * @fileoverview Everything that rewrites a config file as it is read, in the order it runs.
 *
 * This is a registry rather than a folder of implementations. A migration lives wherever its
 * subject lives — the provider rename touches config files, agent records and the keyring, so
 * splitting its config half out here would separate three functions that share one rename and
 * one pair of constants. What belongs in one place is the *list*: which of them run when a
 * config file is loaded, and in what order.
 *
 * The list exists because there were two migrations, each hand-called at two load sites — the
 * ordinary one and the `--config` branch. Adding a third meant remembering four lines, and
 * forgetting the second site would have produced a config that migrates normally and silently
 * does not when an explicit path is passed. Now adding one is a file and a line here.
 *
 * Order matters when two migrations touch the same key, so it is fixed by this array rather
 * than by import order or call-site accident.
 */

import { migrateConfigProviderName } from "@/core/utils/provider-migration";
import { migrateTriggersToWebhooks } from "./triggers-to-webhooks";

/** Names are stable identifiers a caller can test for, not display strings. */
export const PROVIDER_RENAME_MIGRATION = "provider-rename";
export const TRIGGERS_TO_WEBHOOKS_MIGRATION = "triggers-to-webhooks";

export interface ConfigMigration {
  readonly name: string;
  /** Mutates the record in place. Returns whether it changed anything. */
  readonly apply: (fileRecord: Record<string, unknown>) => boolean;
}

export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  { name: PROVIDER_RENAME_MIGRATION, apply: migrateConfigProviderName },
  { name: TRIGGERS_TO_WEBHOOKS_MIGRATION, apply: migrateTriggersToWebhooks },
];

/**
 * Run every migration against a freshly parsed config file.
 *
 * Returns the names of the ones that changed something. Callers care because some changes are
 * worth persisting back — the provider rename is, while the `triggers` key deliberately is
 * not, since a config file is routinely shared with machines running older builds.
 */
export function applyConfigMigrations(fileRecord: Record<string, unknown>): readonly string[] {
  const changed: string[] = [];
  for (const migration of CONFIG_MIGRATIONS) {
    if (migration.apply(fileRecord)) changed.push(migration.name);
  }
  return changed;
}
