/**
 * Regression coverage for the agent inspector's pricing, local URL, and secret
 * projection rules. The fullscreen and Ink screens receive only these fields.
 */

import type { Agent } from "@jazz/core/types/agent";
import { describe, expect, it } from "bun:test";
import { agentDetailFields } from "./agent-details";

function agent(provider: Agent["config"]["llmProvider"], model: string): Agent {
  return {
    id: "a1",
    name: "Research",
    description: "Find useful evidence",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    config: {
      persona: "researcher",
      llmProvider: provider,
      llmModel: model,
      reasoning: "high",
      tools: ["web_search"],
      deniedTools: ["execute_command"],
      llmApiKeys: { [provider]: "secret-api-key" },
      customTools: [
        {
          name: "private_tool",
          description: "Run a private action",
          parameters: { type: "object" },
          handler: { type: "command", command: ["secret-command-token"] },
        },
      ],
    },
  };
}

describe("agent inspector fields", () => {
  it("shows model prices and configuration without exposing credentials or commands", () => {
    const fields = agentDetailFields(agent("anthropic", "claude-sonnet"), {
      contextWindow: 200_000,
      supportsTools: true,
      isReasoningModel: true,
      ingestImage: true,
      ingestPdf: true,
      ingestAudio: false,
      ingestVideo: false,
      generatesImage: false,
      generatesAudio: false,
      generatesVideo: false,
      supportsTemperature: true,
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
    });
    expect(fields).toContainEqual({ section: "Model", label: "Input price", value: "$3/M tokens" });
    expect(fields).toContainEqual({
      section: "Model",
      label: "Output price",
      value: "$15/M tokens",
    });
    expect(fields).toContainEqual({ section: "Model", label: "Persona", value: "researcher" });
    expect(fields).toContainEqual({
      section: "Access",
      label: "Tools denied",
      value: "execute_command",
    });
    expect(fields).toContainEqual({
      section: "Credentials",
      label: "Agent API keys",
      value: "configured (hidden)",
    });
    expect(JSON.stringify(fields)).not.toContain("secret-api-key");
    expect(JSON.stringify(fields)).not.toContain("secret-command-token");
  });

  it("shows the effective local URL without userinfo, query, or fragment", () => {
    const fields = agentDetailFields(
      agent("vllm", "qwen"),
      undefined,
      "https://user:pass@gpu.example:8000/v1?token=secret#fragment",
    );
    expect(fields).toContainEqual({
      section: "Model",
      label: "Host URL",
      value: "https://gpu.example:8000/v1",
    });
    expect(fields).toContainEqual({ section: "Model", label: "Input price", value: "$0/M tokens" });
    expect(JSON.stringify(fields)).not.toContain("secret");
  });

  it("marks unknown prices as unknown", () => {
    const fields = agentDetailFields(agent("openai", "unlisted"), undefined);
    expect(fields).toContainEqual({
      section: "Model",
      label: "Input price",
      value: "price unknown",
    });
    expect(fields).toContainEqual({
      section: "Model",
      label: "Output price",
      value: "price unknown",
    });
  });

  it("does not describe an Ollama cloud model as self-hosted", () => {
    const fields = agentDetailFields(
      agent("ollama", "kimi-k3:cloud"),
      undefined,
      "http://127.0.0.1:11434/api",
    );
    expect(fields.some((field) => field.label === "Host URL")).toBe(false);
    expect(fields).toContainEqual({
      section: "Model",
      label: "Input price",
      value: "price unknown",
    });
  });
});
