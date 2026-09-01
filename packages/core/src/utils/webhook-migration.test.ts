import { describe, expect, it } from "bun:test";
import { migrateTriggersToWebhooks } from "./webhook-migration";

const legacyEntry = { name: "mira", agentId: "default", promptTemplate: "Handle {{payload}}" };

describe("reading the pre-rename triggers config key", () => {
  it("reads a legacy triggers list as webhooks", () => {
    const fileRecord: Record<string, unknown> = { triggers: [legacyEntry] };

    expect(migrateTriggersToWebhooks(fileRecord)).toBe(true);
    expect(fileRecord["webhooks"]).toEqual([legacyEntry]);
    expect(fileRecord["triggers"]).toBeUndefined();
  });

  it("keeps the new key when both are present rather than doubling the list", () => {
    const current = { name: "deploys", agentId: "default", promptTemplate: "Summarise" };
    const fileRecord: Record<string, unknown> = { triggers: [legacyEntry], webhooks: [current] };

    expect(migrateTriggersToWebhooks(fileRecord)).toBe(true);
    expect(fileRecord["webhooks"]).toEqual([current]);
    expect(fileRecord["triggers"]).toBeUndefined();
  });

  it("leaves a config with no legacy key untouched", () => {
    const fileRecord: Record<string, unknown> = { webhooks: [legacyEntry] };

    expect(migrateTriggersToWebhooks(fileRecord)).toBe(false);
    expect(fileRecord["webhooks"]).toEqual([legacyEntry]);
  });

  it("ignores a triggers key that is not a list", () => {
    const fileRecord: Record<string, unknown> = { triggers: "nonsense" };

    expect(migrateTriggersToWebhooks(fileRecord)).toBe(false);
    expect(fileRecord["triggers"]).toBe("nonsense");
  });
});
