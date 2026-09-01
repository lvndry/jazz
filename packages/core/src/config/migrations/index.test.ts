import { describe, expect, it } from "bun:test";
import {
  applyConfigMigrations,
  CONFIG_MIGRATIONS,
  PROVIDER_RENAME_MIGRATION,
  TRIGGERS_TO_WEBHOOKS_MIGRATION,
} from "./index";

describe("applying every config migration", () => {
  it("leaves a config that needs nothing alone, and reports no changes", () => {
    const record: Record<string, unknown> = { webhooks: [{ name: "deploys" }] };

    expect(applyConfigMigrations(record)).toEqual([]);
    expect(record).toEqual({ webhooks: [{ name: "deploys" }] });
  });

  it("runs migrations for unrelated keys in one pass", () => {
    const record: Record<string, unknown> = {
      llm: { google: { api_key: "k" } },
      triggers: [{ name: "deploys" }],
    };

    const changed = applyConfigMigrations(record);

    expect(changed).toContain(PROVIDER_RENAME_MIGRATION);
    expect(changed).toContain(TRIGGERS_TO_WEBHOOKS_MIGRATION);
    expect(record["webhooks"]).toEqual([{ name: "deploys" }]);
  });

  it("names every migration distinctly, so a caller can test for one", () => {
    // A duplicate name would make `changed.includes(...)` ambiguous, and the config loader
    // uses exactly that to decide whether a rename is worth persisting back.
    const names = CONFIG_MIGRATIONS.map((migration) => migration.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it("is what the loader runs, so a migration added to the list cannot be half-wired", () => {
    // The failure this list exists to prevent: two migrations were each hand-called at two
    // load sites, and a third wired into only one would have migrated an ordinary config but
    // silently skipped one loaded with an explicit --config path.
    const seen: string[] = [];
    for (const migration of CONFIG_MIGRATIONS) {
      const record: Record<string, unknown> = {
        llm: { google: { api_key: "k" } },
        triggers: [{ name: "deploys" }],
      };
      if (migration.apply(record)) seen.push(migration.name);
    }

    expect(seen).toEqual(CONFIG_MIGRATIONS.map((migration) => migration.name));
  });
});
