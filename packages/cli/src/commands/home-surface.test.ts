import { describe, expect, it } from "bun:test";
import { environmentKeyDetections, ollamaOrigin, probeOllamaModels } from "./home-detection";
import {
  HOME_CONVERSATION_LIMIT,
  greetingFor,
  homeActions,
  homeConversations,
  homeStatus,
  openConversationValue,
  parseOpenConversationValue,
  type HomeConversationSource,
} from "./home-surface";

const NOW = new Date("2026-09-28T09:30:00Z").getTime();
const MINUTE = 60_000;

function source(
  id: string,
  minutesAgo: number,
  overrides: Partial<HomeConversationSource> = {},
): HomeConversationSource {
  return {
    agentId: "agent-1",
    agentName: "sol",
    conversationId: id,
    title: `Conversation ${id}`,
    startedAt: new Date(NOW - minutesAgo * MINUTE).toISOString(),
    endedAt: null,
    messageCount: 4,
    ...overrides,
  };
}

describe("homeConversations", () => {
  it("puts conversations waiting on you first, then the most recent, keyed 1 2 3", () => {
    const entries = homeConversations(
      [source("recent", 5), source("old-waiting", 600), source("older", 60), source("oldest", 900)],
      new Map([["old-waiting", "goal venue waiting for your answer"]]),
      NOW,
    );
    expect(entries.map((entry) => entry.title)).toEqual([
      "Conversation old-waiting",
      "Conversation recent",
      "Conversation older",
    ]);
    expect(entries.map((entry) => entry.key)).toEqual(["1", "2", "3"]);
    expect(entries).toHaveLength(HOME_CONVERSATION_LIMIT);
    expect(entries[0]).toMatchObject({
      waiting: true,
      detail: "goal venue waiting for your answer",
      age: "10h ago",
    });
    expect(entries[1]).toMatchObject({ waiting: false, detail: "4 messages", age: "5m ago" });
  });

  it("measures age from when the conversation last ended, not when it started", () => {
    const [entry] = homeConversations(
      [source("c", 600, { endedAt: new Date(NOW - 2 * MINUTE).toISOString() })],
      new Map(),
      NOW,
    );
    expect(entry?.age).toBe("2m ago");
  });
});

describe("open conversation values", () => {
  it("round-trip an agent and a conversation id, including ids with colons", () => {
    const value = openConversationValue("agent-1", "conv:with:colons");
    expect(parseOpenConversationValue(value)).toEqual({
      agentId: "agent-1",
      conversationId: "conv:with:colons",
    });
    expect(parseOpenConversationValue("new-conversation")).toBeNull();
  });
});

describe("homeActions", () => {
  it("names the default agent on enter and keeps each action on one key", () => {
    const actions = homeActions({ agentCount: 3, defaultAgentName: "sol", hasHistory: true });
    expect(actions[0]).toEqual({
      key: "enter",
      label: "new conversation with sol",
      value: "new-conversation",
    });
    const keys = actions.map((action) => action.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["enter", "a", "n", "r", "l", "s", "q"]);
  });

  it("drops the agent switcher for a single agent and resume without history", () => {
    const keys = homeActions({ agentCount: 1, defaultAgentName: "sol", hasHistory: false }).map(
      (action) => action.key,
    );
    expect(keys).toEqual(["enter", "n", "l", "s", "q"]);
  });

  it("starts setup on first run, and offers Ollama only when it serves models", () => {
    expect(
      homeActions({
        agentCount: 0,
        defaultAgentName: undefined,
        hasHistory: false,
        ollamaModels: 3,
      }),
    ).toContainEqual({
      key: "o",
      label: "use Ollama, no key needed",
      value: "create-agent:ollama",
    });
    const withoutOllama = homeActions({
      agentCount: 0,
      defaultAgentName: undefined,
      hasHistory: false,
    });
    expect(withoutOllama[0]?.value).toBe("create-agent");
    expect(withoutOllama.some((action) => action.key === "o")).toBe(false);
  });
});

describe("homeStatus", () => {
  it("warns with the settings key when no provider has a key", () => {
    expect(homeStatus({ agentCount: 2, providerCount: 0 })).toEqual([
      { text: "2 agents" },
      { text: "no model provider has a key", tone: "warning", fixKey: "s" },
    ]);
    expect(homeStatus({ agentCount: 1, providerCount: 1 })).toEqual([
      { text: "1 agent" },
      { text: "1 provider ready" },
    ]);
  });
});

describe("greetingFor", () => {
  it("follows the local time of day", () => {
    expect(greetingFor(new Date(2026, 8, 28, 8))).toBe("Good morning.");
    expect(greetingFor(new Date(2026, 8, 28, 14))).toBe("Good afternoon.");
    expect(greetingFor(new Date(2026, 8, 28, 21))).toBe("Good evening.");
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
    const fake = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ models: [{}, {}, {}] }), { status: 200 });
    }) as typeof fetch;
    expect(await probeOllamaModels(ollamaOrigin("http://10.0.0.5:11434/v1"), fake)).toBe(3);
    expect(requested).toEqual(["http://10.0.0.5:11434/api/tags"]);
  });

  it("treats a server that does not answer as not running", async () => {
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    expect(await probeOllamaModels(ollamaOrigin(undefined), failing)).toBeUndefined();
    expect(ollamaOrigin("not a url")).toBe("http://127.0.0.1:11434");
  });
});
