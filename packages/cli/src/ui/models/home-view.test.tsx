import { describe, expect, it } from "bun:test";
import { renderToString } from "ink";
import {
  homeIntent,
  homeSentences,
  orderRecentAgents,
  readableTitle,
  stepTarget,
  targetAgent,
  waitingEntries,
  waitingTag,
  type HomeModel,
} from "./home-view";
import { buildHome } from "../../commands/home-surface";
import { InkHome } from "../InkHome";

const HOME: HomeModel = {
  version: "0.14.2",
  shownAt: 1,
  agents: [
    { id: "sol", name: "sol", model: "gpt-5.6-sol", persona: "default", lastUsed: "now" },
    { id: "luna", name: "luna", model: "gpt-5.6-luna", persona: "default", lastUsed: "2h ago" },
    { id: "terra", name: "coder-terra", model: "gpt-5.6-sol", persona: "coder" },
  ],
  agentCount: 31,
  targetAgentId: "sol",
  waiting: [
    {
      key: "1",
      value: "open:luna:c1",
      title: "Wedding venue",
      agent: "luna",
      reason: "question",
      age: "1d ago",
      detail: "Which venue should I confirm with Dana?",
    },
  ],
  keys: [
    { key: "n", label: "new agent", value: "create-agent" },
    { key: "r", label: "resume", value: "resume-conversation" },
    { key: "q", label: "quit", value: "exit" },
  ],
};

describe("targeting", () => {
  it("starts on the chosen agent and falls back to the first offered", () => {
    expect(targetAgent(HOME, "luna")?.name).toBe("luna");
    expect(targetAgent(HOME, "gone")?.name).toBe("sol");
  });

  it("moves with the arrows and stops at either end", () => {
    expect(stepTarget(HOME, "sol", 1)).toBe("luna");
    expect(stepTarget(HOME, "sol", -1)).toBe("sol");
    expect(stepTarget(HOME, "terra", 1)).toBe("terra");
  });

  it("offers the last-used agent first, then by recent use, then by name", () => {
    const ordered = orderRecentAgents(
      [
        { id: "a", name: "zed", model: "m", persona: "default" },
        { id: "b", name: "amy", model: "m", persona: "default" },
        { id: "c", name: "old", model: "m", persona: "default", lastUsedMs: 10 },
        { id: "d", name: "new", model: "m", persona: "default", lastUsedMs: 20 },
        { id: "e", name: "pinned", model: "m", persona: "default", lastUsedMs: 1 },
      ],
      "e",
    );
    expect(ordered.map((agent) => agent.name)).toEqual(["pinned", "new", "old", "amy", "zed"]);
  });

  it("puts an agent picked from the full list first, keeping five", () => {
    const agents = ["a", "b", "c", "d", "e", "f"].map((id, index) => ({
      id,
      name: id,
      model: "m",
      persona: "default",
      lastUsedMs: 100 - index,
    }));
    const home = buildHome({
      shownAt: 1,
      agents,
      lastUsedAgentId: "a",
      lastUsedWords: new Map(),
      targetAgentId: "f",
      waiting: [],
      providerCount: 1,
    });
    expect(home.agents.map((agent) => agent.id)).toEqual(["f", "a", "b", "c", "d"]);
    expect(home.targetAgentId).toBe("f");
  });
});

describe("keys", () => {
  it("enter starts a conversation with the target and hands over what was typed", () => {
    expect(homeIntent(HOME, "luna", "plan my week", { name: "return" })).toEqual({
      kind: "answer",
      value: "start:luna",
      text: "plan my week",
    });
    expect(homeIntent(HOME, undefined, "", { name: "return" })).toEqual({
      kind: "answer",
      value: "start:sol",
      text: "",
    });
  });

  it("tab opens every agent and keeps the draft", () => {
    expect(homeIntent(HOME, "sol", "hi", { name: "tab" })).toEqual({
      kind: "answer",
      value: "pick-agent",
      text: "hi",
    });
  });

  it("single keys act only while the composer is empty", () => {
    expect(homeIntent(HOME, "sol", "", { name: "n", sequence: "n" })).toEqual({
      kind: "answer",
      value: "create-agent",
    });
    expect(homeIntent(HOME, "sol", "", { name: "1", sequence: "1" })).toEqual({
      kind: "answer",
      value: "open:luna:c1",
    });
    expect(homeIntent(HOME, "sol", "k", { name: "n", sequence: "n" })).toEqual({ kind: "type" });
    expect(homeIntent(HOME, "sol", "", { name: "x", sequence: "x" })).toEqual({ kind: "type" });
  });

  it("esc empties the composer and never leaves home", () => {
    expect(homeIntent(HOME, "sol", "draft", { name: "escape" })).toEqual({ kind: "clear" });
    expect(homeIntent(HOME, "sol", "", { name: "escape" })).toEqual({ kind: "clear" });
  });
});

describe("readableTitle", () => {
  it("prefers a work name in words, and never shows an id", () => {
    expect(readableTitle({ workName: "organize-downloads", agentName: "sol" })).toBe(
      "Organize downloads",
    );
    expect(
      readableTitle({ workName: "13c7d914", objective: "Tidy the inbox.", agentName: "sol" }),
    ).toBe("Tidy the inbox");
  });

  it("names URLs, drops the slash command and the word a cut title broke", () => {
    expect(
      readableTitle({
        conversationTitle: "/goal https://github.com/lvndry/jazz/pull/660 m…",
        agentName: "sol",
      }),
    ).toBe("Pull request #660 in lvndry/jazz");
    expect(
      readableTitle({ conversationTitle: "check https://www.example.com/a", agentName: "x" }),
    ).toBe("Check example.com");
  });

  it("falls back to the agent rather than 'untitled conversation'", () => {
    expect(readableTitle({ conversationTitle: "untitled conversation", agentName: "luna" })).toBe(
      "A conversation with luna",
    );
  });

  it("keeps a long title to one line, ending on a word", () => {
    const title = readableTitle({
      objective:
        "Make PR 660 production-ready for a one-way, irreversible migration of every stored record",
      agentName: "sol",
    });
    expect(title.length).toBeLessThanOrEqual(48);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/[,\s]…$/);
  });
});

describe("waiting", () => {
  it("numbers the entries and words what each needs", () => {
    const [entry] = waitingEntries([
      {
        agentId: "luna",
        agentName: "luna",
        conversationId: "c1",
        workName: "wedding-venue",
        reason: "question",
        age: "1d ago",
        detail: "Which  venue\\nshould I confirm?",
      },
    ]);
    expect(entry).toMatchObject({ key: "1", value: "open:luna:c1", title: "Wedding venue" });
    expect(waitingTag("question", "1d ago")).toBe("asked 1d ago");
    expect(waitingTag("review", "1d ago")).toBe("needs review · 1d");
  });
});

describe("Ink reading", () => {
  it("reads home as complete sentences", () => {
    const sentences = homeSentences(HOME, "sol");
    expect(sentences.start).toBe("New conversation with sol (gpt-5.6-sol)");
    expect(sentences.agents[1]?.text).toBe("luna, gpt-5.6-luna, everyday, used 2h ago");
    expect(sentences.agents[2]?.text).toBe("coder-terra, gpt-5.6-sol, coder, not used yet");
    expect(sentences.waiting[0]).toBe("1  Wedding venue, luna, asked you 1d ago");
  });

  it("renders the same content on the Ink path", () => {
    const text = renderToString(
      <InkHome
        model={HOME}
        onAnswer={() => undefined}
      />,
      { columns: 100 },
    );
    expect(text).toContain("› New conversation with sol (gpt-5.6-sol)");
    expect(text).toContain("Or type your first message:");
    expect(text).toContain("Your agents, 31");
    expect(text).toContain("Waiting for you, 1");
    expect(text).toContain("n new agent · r resume · q quit");
  });
});
