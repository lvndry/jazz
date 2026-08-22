import { describe, expect, it } from "bun:test";
import { configuredProviderNames, homeRequirements } from "./home-readiness";

describe("homeRequirements", () => {
  it("matches the first-run setup list when nothing is configured", () => {
    const rows = homeRequirements({
      agentCount: 0,
    });
    expect(rows).toEqual([
      { label: "agent", ready: false, detail: "none yet", remedy: "create your first one below" },
    ]);
  });

  it("matches the settled setup list when agents exist", () => {
    const rows = homeRequirements({
      agentCount: 4,
    });
    expect(rows).toEqual([{ label: "agent", ready: true, detail: "4 of them" }]);
  });

  it("names a single agent", () => {
    const rows = homeRequirements({
      agentCount: 1,
    });
    expect(rows).toEqual([{ label: "agent", ready: true, detail: "1 of them" }]);
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
