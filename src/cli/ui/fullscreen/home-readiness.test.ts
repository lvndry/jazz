import { describe, expect, it } from "bun:test";
import { configuredProviderNames, homeRequirements } from "./home-readiness";

describe("homeRequirements", () => {
  it("matches the first-run setup list when nothing is configured", () => {
    const rows = homeRequirements({
      configuredProviders: [],
      agentCount: 0,
      connectors: new Map(),
    });
    expect(rows).toEqual([
      {
        label: "provider",
        ready: false,
        detail: "no key yet",
        remedy: "add a key with jazz config",
      },
      { label: "agent", ready: false, detail: "none yet", remedy: "create your first one below" },
      { label: "apps", ready: false, detail: "none connected", remedy: "optional, add later" },
    ]);
  });

  it("matches the settled setup list when a provider and agents exist", () => {
    const rows = homeRequirements({
      configuredProviders: ["anthropic"],
      preferredProvider: "anthropic",
      preferredModel: "claude-sonnet-4",
      agentCount: 4,
      connectors: new Map(),
    });
    expect(rows).toEqual([
      { label: "provider", ready: true, detail: "anthropic, claude-sonnet-4" },
      { label: "agent", ready: true, detail: "4 of them" },
      { label: "apps", ready: false, detail: "none connected", remedy: "optional, add later" },
    ]);
  });

  it("counts live connectors and names a partial set", () => {
    const rows = homeRequirements({
      configuredProviders: ["openai"],
      agentCount: 1,
      connectors: new Map([
        ["gmail", "live"],
        ["calendar", "offline"],
        ["notion", "live"],
      ]),
    });
    expect(rows[2]).toEqual({
      label: "apps",
      ready: true,
      detail: "2 of 3 connected",
    });
    expect(rows[1]?.detail).toBe("1 of them");
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
