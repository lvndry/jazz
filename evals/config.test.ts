import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { isAllowedEvalModel } from "./config";

describe("isAllowedEvalModel", () => {
  it("allows any OpenRouter :free model", () => {
    expect(isAllowedEvalModel("openrouter", "qwen/qwen3-next-80b-a3b-instruct:free")).toBe(true);
    expect(isAllowedEvalModel("openrouter", "meta-llama/llama-3.1-8b:free")).toBe(true);
  });
  it("allows only the cheap OpenAI tiers", () => {
    expect(isAllowedEvalModel("openai", "gpt-5.4-nano")).toBe(true);
    expect(isAllowedEvalModel("openai", "gpt-5.4-mini")).toBe(true);
  });
  it("rejects expensive / non-free models", () => {
    expect(isAllowedEvalModel("openai", "gpt-5.4")).toBe(false);
    expect(isAllowedEvalModel("openrouter", "anthropic/claude-opus-4-8")).toBe(false); // not :free
    expect(isAllowedEvalModel("anthropic", "claude-opus-4-8")).toBe(false);
    expect(isAllowedEvalModel("openai", "gpt-5.4-turbo")).toBe(false);
  });
});

describe("committed eval agents obey the cost guardrail", () => {
  it("every evals/agents/*.json uses a free or cheap model", () => {
    const dir = join(import.meta.dir, "agents");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const agent = JSON.parse(readFileSync(join(dir, file), "utf-8")) as {
        config: { llmProvider: string; llmModel: string };
      };
      const allowed = isAllowedEvalModel(agent.config.llmProvider, agent.config.llmModel);
      expect(allowed, `${file} uses ${agent.config.llmProvider}/${agent.config.llmModel}`).toBe(
        true,
      );
    }
  });
});
