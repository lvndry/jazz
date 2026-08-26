import * as os from "os";
import { describe, expect, it } from "bun:test";
import { configuredProviderNames, homeEnvironmentFacts, homeRequirements } from "./home-readiness";

describe("homeRequirements", () => {
  it("matches the first-run setup list when nothing is configured", () => {
    const rows = homeRequirements({
      agentCount: 0,
    });
    expect(rows).toEqual([
      { label: "agents", ready: false, detail: "none yet", remedy: "create your first one below" },
    ]);
  });

  it("matches the settled setup list when agents exist", () => {
    const rows = homeRequirements({
      agentCount: 4,
    });
    expect(rows).toEqual([{ label: "agents", ready: true, detail: "4" }]);
  });

  it("names a single agent", () => {
    const rows = homeRequirements({
      agentCount: 1,
    });
    expect(rows).toEqual([{ label: "agents", ready: true, detail: "1" }]);
  });
});

describe("homeEnvironmentFacts", () => {
  it("reports the four facts agents are grounded with, in reading order", () => {
    const rows = homeEnvironmentFacts();
    expect(rows.map((row) => row.label)).toEqual(["date", "os", "cwd", "hardware"]);
  });

  it("grounds every row in the live machine, not placeholders", () => {
    const rows = homeEnvironmentFacts();
    const byLabel = new Map(rows.map((row) => [row.label, row.detail]));
    expect(byLabel.get("date")).toContain("UTC");
    expect(byLabel.get("os")).toContain(os.platform());
    expect(byLabel.get("cwd")).toBe(process.cwd());
    expect(byLabel.get("hardware")).toMatch(/\d+ cores/);
  });

  it("keeps the date row aligned with the system prompt's {currentDate} shape", () => {
    // The wizard's report and the agent's Environment block share one source;
    // this pins the shared format so neither can silently drift.
    const detail = homeEnvironmentFacts()[0]?.detail ?? "";
    expect(detail).toMatch(/^[A-Z][a-z]+day, \w+ \d{1,2}, \d{4} \(UTC[+-]?[\d:]*, .+\)$/);
  });
});

describe("configuredProviderNames", () => {
  it("reads configured keys from the app config without inventing local providers", () => {
    const previous = process.env["OLLAMA_API_KEY"];
    delete process.env["OLLAMA_API_KEY"];
    try {
      expect(
        configuredProviderNames({
          storage: { type: "file", path: "/tmp" },
          logging: { level: "info", format: "plain" },
          llm: { anthropic: { api_key: "sk-test" }, ollama: {} },
        }),
      ).toEqual(["anthropic"]);
    } finally {
      if (previous === undefined) delete process.env["OLLAMA_API_KEY"];
      else process.env["OLLAMA_API_KEY"] = previous;
    }
  });

  it("picks up a key that only exists in the environment", () => {
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-env";
    try {
      expect(
        configuredProviderNames({
          storage: { type: "file", path: "/tmp" },
          logging: { level: "info", format: "plain" },
        }),
      ).toContain("openai");
    } finally {
      if (previous === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = previous;
    }
  });

  it("picks up an Ollama key that only exists in the environment", () => {
    const previous = process.env["OLLAMA_API_KEY"];
    process.env["OLLAMA_API_KEY"] = "ollama-env";
    try {
      expect(
        configuredProviderNames({
          storage: { type: "file", path: "/tmp" },
          logging: { level: "info", format: "plain" },
        }),
      ).toContain("ollama");
    } finally {
      if (previous === undefined) delete process.env["OLLAMA_API_KEY"];
      else process.env["OLLAMA_API_KEY"] = previous;
    }
  });
});
