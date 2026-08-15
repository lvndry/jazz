import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { agentIdForChat, isChatAgentId, readAgentFile, syncAgentDisplayName } from "./agents";

describe("agent ids", () => {
  it("keeps negative group chat ids filename-safe", () => {
    expect(agentIdForChat(-1001234567890)).toBe("tg_n1001234567890");
  });

  it("recognises chat agent ids and rejects helper ids", () => {
    expect(isChatAgentId("tg_879894259")).toBe(true);
    expect(isChatAgentId("tg_n1001234567890")).toBe(true);
    expect(isChatAgentId("tg_suggest")).toBe(false);
    expect(isChatAgentId("telegram")).toBe(false);
  });
});

describe("syncAgentDisplayName", () => {
  function seed(dataDir: string, agentId: string, name: string): void {
    mkdirSync(join(dataDir, "agents"), { recursive: true });
    writeFileSync(
      join(dataDir, "agents", `${agentId}.json`),
      JSON.stringify({ id: agentId, name, model: "ollama/test", config: {} }),
    );
  }

  function nameOf(dataDir: string, agentId: string): string {
    return readAgentFile(dataDir, agentId).name;
  }

  it("renames the seed and every chat agent, leaving helper agents alone", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jazz-telegram-agents-test-"));
    seed(dataDir, "telegram", "Jazz");
    seed(dataDir, "tg_879894259", "tg_879894259");
    seed(dataDir, "tg_suggest", "tg_suggest");

    syncAgentDisplayName(dataDir, "telegram", "Alfred");

    expect(nameOf(dataDir, "telegram")).toBe("Alfred");
    expect(nameOf(dataDir, "tg_879894259")).toBe("Alfred");
    expect(nameOf(dataDir, "tg_suggest")).toBe("tg_suggest");
  });

  it("is a no-op when the agents directory does not exist yet", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jazz-telegram-agents-test-"));
    expect(() => syncAgentDisplayName(dataDir, "telegram", "Alfred")).not.toThrow();
  });
});
