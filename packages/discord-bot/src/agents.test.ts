import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  agentIdForChannel,
  channelIdFromAgentId,
  readAgentFile,
  syncAgentDisplayName,
} from "./agents";

describe("agent ids", () => {
  it("prefixes Discord snowflakes so they cannot collide with Telegram agents", () => {
    expect(agentIdForChannel("123456789012345678")).toBe("dc_123456789012345678");
  });

  it("round-trips a valid agent id", () => {
    const channelId = "123456789012345678";
    expect(channelIdFromAgentId(agentIdForChannel(channelId))).toBe(channelId);
  });

  it("rejects Telegram and junk agent ids", () => {
    expect(channelIdFromAgentId("tg_123")).toBeNull();
    expect(channelIdFromAgentId("dc_not-a-snowflake")).toBeNull();
    expect(channelIdFromAgentId("dc_")).toBeNull();
  });
});

describe("syncAgentDisplayName", () => {
  function seed(dataDir: string, agentId: string, name: string): void {
    mkdirSync(join(dataDir, "agents"), { recursive: true });
    writeFileSync(
      join(dataDir, "agents", `${agentId}.json`),
      JSON.stringify({ id: agentId, name, config: {} }),
    );
  }

  function nameOf(dataDir: string, agentId: string): string {
    return readAgentFile(dataDir, agentId).name;
  }

  it("renames the seed and every conversation agent, leaving helper agents alone", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jazz-discord-agents-test-"));
    seed(dataDir, "discord", "Jazz");
    seed(dataDir, "dc_123456789012345678", "dc_123456789012345678");
    seed(dataDir, "dc_suggest", "dc_suggest");

    syncAgentDisplayName(dataDir, "discord", "Alfred");

    expect(nameOf(dataDir, "discord")).toBe("Alfred");
    expect(nameOf(dataDir, "dc_123456789012345678")).toBe("Alfred");
    expect(nameOf(dataDir, "dc_suggest")).toBe("dc_suggest");
  });

  it("is a no-op when the agents directory does not exist yet", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jazz-discord-agents-test-"));
    expect(() => syncAgentDisplayName(dataDir, "discord", "Alfred")).not.toThrow();
  });
});
