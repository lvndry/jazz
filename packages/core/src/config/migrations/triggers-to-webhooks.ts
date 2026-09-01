/**
 * Back-compatible reading of the `triggers` config key under its new name, `webhooks`.
 *
 * The feature was renamed because "trigger" already named an unrelated thing — a wake
 * trigger is an alarm clock an agent sets for itself, a webhook is a door somebody else
 * knocks on. Unlike the provider rename, the old key is never rewritten on disk and stays
 * supported indefinitely: a config file is routinely shared with machines running older
 * jazz builds, which would stop serving their webhooks the moment the key disappeared.
 */

/**
 * Fold a legacy `triggers` list into `webhooks` in a raw config file record.
 * Returns whether anything changed.
 */
export function migrateTriggersToWebhooks(fileRecord: Record<string, unknown>): boolean {
  const legacy = fileRecord["triggers"];
  if (!Array.isArray(legacy)) return false;

  // A list already written under the new name wins outright rather than being concatenated:
  // both keys describe the same set of webhooks, so merging them would duplicate every entry
  // for anyone who adopted the new key while the old one was still on disk.
  const current = fileRecord["webhooks"];
  if (!Array.isArray(current)) {
    fileRecord["webhooks"] = legacy;
  }
  delete fileRecord["triggers"];
  return true;
}
