import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { validateAgents } from "./validate-agents";

const storage = mkdtempSync(path.join(tmpdir(), "jazz-validate-agents-"));
mkdirSync(path.join(storage, "agents"));
const agentFile = (id: string, provider: string, tools: string[]) =>
  JSON.stringify({
    id,
    name: id,
    config: { persona: "default", llm: { provider, model: "m" }, tools },
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  });
writeFileSync(
  path.join(storage, "agents", "good.json"),
  agentFile("good", "openai", ["read_file"]),
);
writeFileSync(
  path.join(storage, "agents", "typo.json"),
  agentFile("typo", "opneai", ["read_fille"]),
);
writeFileSync(path.join(storage, "agents", "broken.json"), '{"id": "broken"');

afterAll(() => {
  rmSync(storage, { recursive: true, force: true });
});

describe("validateAgents", () => {
  it("reports unreadable files and bad providers as errors, unknown tools as warnings", async () => {
    const report = await Effect.runPromise(validateAgents(storage));

    expect(report.agentCount).toBe(2);
    expect(report.errors.some((line) => line.includes("broken.json"))).toBe(true);
    expect(report.errors.some((line) => line.includes('"opneai"'))).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("read_fille");
  });
});
