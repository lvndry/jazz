import { describe, expect, it } from "bun:test";
import {
  environmentKeyDetections,
  ollamaOrigin,
  probeOllamaModels,
  type ProbeFetch,
} from "./home-detection";
import { buildHome, firstRunActions } from "./home-surface";
import { openConversationValue, parseOpenConversationValue } from "../ui/models/home-view";

describe("buildHome", () => {
  const agents = [
    { id: "sol", name: "sol", model: "gpt-5.6-sol", persona: "default", lastUsedMs: 20 },
    { id: "luna", name: "luna", model: "gpt-5.6-luna", persona: "default", lastUsedMs: 10 },
  ];

  it("offers the recent agents with their worded last use, and the footer keys", () => {
    const home = buildHome({
      shownAt: 7,
      agents,
      lastUsedAgentId: "luna",
      lastUsedWords: new Map([["luna", "2h ago"]]),
      waiting: [],
      providerCount: 1,
    });
    expect(home.shownAt).toBe(7);
    expect(home.agents.map((agent) => agent.id)).toEqual(["luna", "sol"]);
    expect(home.agents[0]?.lastUsed).toBe("2h ago");
    expect(home.agents[1]?.lastUsed).toBeUndefined();
    expect(home.commands.map((command) => command.name)).toEqual([
      "new",
      "resume",
      "agents",
      "settings",
      "quit",
    ]);
    expect(home.warning).toBeUndefined();
    expect(home.firstRun).toBeUndefined();
  });

  it("warns with the settings key when no provider can answer, and keeps a draft", () => {
    const home = buildHome({
      shownAt: 1,
      agents,
      lastUsedAgentId: null,
      lastUsedWords: new Map(),
      draft: "plan my week",
      waiting: [],
      providerCount: 0,
    });
    expect(home.warning).toEqual({ text: "no model provider has a key", fix: "/settings" });
    expect(home.draft).toBe("plan my week");
  });

  it("is a first-run screen with setup keys when there is no agent", () => {
    const home = buildHome({
      shownAt: 1,
      agents: [],
      lastUsedAgentId: null,
      lastUsedWords: new Map(),
      waiting: [],
      providerCount: 0,
      ollamaModels: 3,
      detected: [{ label: "Ollama", detail: "running" }],
    });
    expect(home.firstRun?.detected).toHaveLength(1);
    expect(home.firstRun?.actions.map((action) => action.value)).toEqual([
      "create-agent",
      "create-agent:ollama",
      "settings",
    ]);
    expect(firstRunActions(undefined).map((action) => action.value)).toEqual([
      "create-agent",
      "settings",
    ]);
  });
});

describe("open conversation values", () => {
  it("round-trip an agent and a conversation id, including ids with colons", () => {
    const value = openConversationValue("agent-1", "conv:with:colons");
    expect(parseOpenConversationValue(value)).toEqual({
      agentId: "agent-1",
      conversationId: "conv:with:colons",
    });
    expect(parseOpenConversationValue("start:agent-1")).toBeNull();
  });
});

describe("first-run detection", () => {
  it("reports provider keys exported in the environment by variable name", () => {
    const detections = environmentKeyDetections({ OPENAI_API_KEY: "sk-test", EMPTY: "" });
    expect(detections).toContainEqual({ label: "OPENAI_API_KEY", detail: "in your environment" });
    expect(environmentKeyDetections({ OPENAI_API_KEY: "   " })).toEqual([]);
  });

  it("probes the configured Ollama origin and counts its models", async () => {
    const requested: string[] = [];
    const fake: ProbeFetch = async (url) => {
      requested.push(url);
      return new Response(JSON.stringify({ models: [{}, {}, {}] }), { status: 200 });
    };
    expect(await probeOllamaModels(ollamaOrigin("http://10.0.0.5:11434/v1"), fake)).toBe(3);
    expect(requested).toEqual(["http://10.0.0.5:11434/api/tags"]);
  });

  it("treats a server that does not answer as not running", async () => {
    const failing: ProbeFetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await probeOllamaModels(ollamaOrigin(undefined), failing)).toBeUndefined();
    expect(ollamaOrigin("not a url")).toBe("http://127.0.0.1:11434");
  });
});
