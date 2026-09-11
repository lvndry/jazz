import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { agentPath } from "./agent-file";
import { DEFAULT_BRIDGE_TOOLS, ensureSeedAgent } from "./seed-agent";

const SPEC = {
  id: "telegram",
  name: "Jazz",
  description: "Everyday assistant reachable from Telegram.",
  provider: "openai",
  model: "gpt-5.4",
  reasoningEffort: "medium",
} as const;

function home(): string {
  return mkdtempSync(join(tmpdir(), "jazz-seed-"));
}

function readAgent(dataDir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(agentPath(dataDir, id), "utf8")) as Record<string, unknown>;
}

describe("ensureSeedAgent", () => {
  test("writes the agent the container entrypoint used to sed into place", () => {
    const dataDir = home();
    expect(ensureSeedAgent(dataDir, SPEC)).toBe(true);

    // The shape the deleted agent.telegram.json produced, field for field.
    expect(readAgent(dataDir, "telegram")).toMatchObject({
      id: "telegram",
      name: "Jazz",
      description: "Everyday assistant reachable from Telegram.",
      config: {
        agentType: "default",
        llmProvider: "openai",
        llmModel: "gpt-5.4",
        reasoningEffort: "medium",
        persona: "default",
        tools: [...DEFAULT_BRIDGE_TOOLS],
      },
    });
  });

  test("leaves a model the operator changed from their phone alone", () => {
    const dataDir = home();
    ensureSeedAgent(dataDir, SPEC);

    const edited = readAgent(dataDir, "telegram");
    (edited["config"] as Record<string, unknown>)["llmModel"] = "claude-sonnet-5";
    writeFileSync(agentPath(dataDir, "telegram"), JSON.stringify(edited));

    // The entrypoint's sed rewrote this file on every restart, so a redeploy
    // silently put the default model back. Seeding in-process does not.
    expect(ensureSeedAgent(dataDir, SPEC)).toBe(false);
    expect((readAgent(dataDir, "telegram")["config"] as Record<string, unknown>)["llmModel"]).toBe(
      "claude-sonnet-5",
    );
  });

  test("gives every bridge the same toolset, which is a product decision", () => {
    const dataDir = home();
    ensureSeedAgent(dataDir, { ...SPEC, id: "discord", description: "Reachable from Discord." });
    ensureSeedAgent(dataDir, { ...SPEC, id: "imessage", description: "Reachable from Messages." });

    for (const id of ["discord", "imessage"]) {
      expect((readAgent(dataDir, id)["config"] as Record<string, unknown>)["tools"]).toEqual([
        ...DEFAULT_BRIDGE_TOOLS,
      ]);
    }
  });
});
