import { describe, expect, it } from "bun:test";
import { configuredProviderNames } from "./configured-providers";

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
