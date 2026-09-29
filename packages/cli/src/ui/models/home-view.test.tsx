import { describe, expect, it } from "bun:test";
import { renderToString } from "ink";
import {
  HOME_COMMANDS,
  briefDetail,
  enterHint,
  homeCommandMatches,
  homeIntent,
  homeSentences,
  orderRecentAgents,
  readableTitle,
  targetAgent,
  waitingEntries,
  waitingTag,
  type HomeModel,
  type HomeState,
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
  commands: HOME_COMMANDS,
};

const EMPTY: HomeState = { agentId: "sol", waitingValue: undefined, draft: "", commandIndex: 0 };

describe("targeting", () => {
  it("starts on the chosen agent and falls back to the first offered", () => {
    expect(targetAgent(HOME, "luna")?.name).toBe("luna");
    expect(targetAgent(HOME, "gone")?.name).toBe("sol");
  });

  it("walks the agents with the arrows, then on into waiting, and back", () => {
    const at = (patch: Partial<HomeState>): HomeState => ({ ...EMPTY, ...patch });
    expect(homeIntent(HOME, at({}), { name: "down" })).toMatchObject({
      patch: { agentId: "luna", waitingValue: undefined },
    });
    expect(homeIntent(HOME, at({}), { name: "up" })).toMatchObject({ patch: { agentId: "sol" } });
    expect(homeIntent(HOME, at({ agentId: "terra" }), { name: "down" })).toMatchObject({
      patch: { waitingValue: "open:luna:c1" },
    });
    const onWaiting = at({ agentId: "terra", waitingValue: "open:luna:c1" });
    expect(homeIntent(HOME, onWaiting, { name: "down" })).toMatchObject({
      patch: { waitingValue: "open:luna:c1" },
    });
    expect(homeIntent(HOME, onWaiting, { name: "up" })).toMatchObject({
      patch: { agentId: "terra", waitingValue: undefined },
    });
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
  const at = (patch: Partial<HomeState>): HomeState => ({ ...EMPTY, ...patch });

  it("enter starts a conversation with the target and hands over what was typed", () => {
    expect(
      homeIntent(HOME, at({ agentId: "luna", draft: "plan my week" }), { name: "return" }),
    ).toEqual({
      kind: "answer",
      value: "start:luna",
      text: "plan my week",
    });
  });

  it("/start answers with its command, leaving the agent to be picked", () => {
    expect(homeIntent(HOME, at({ agentId: "luna", draft: "/start" }), { name: "return" })).toEqual({
      kind: "answer",
      value: "start-conversation",
    });
  });

  it("letters and digits always type, even the ones that used to be shortcuts", () => {
    for (const character of ["n", "r", "q", "s", "1", "2"]) {
      expect(homeIntent(HOME, at({}), { name: character, sequence: character })).toEqual({
        kind: "state",
        patch: { waitingValue: undefined, commandIndex: 0 },
        edit: true,
      });
    }
  });

  it("enter on a selected waiting conversation opens it; typing goes back to the agent", () => {
    const onWaiting = at({ waitingValue: "open:luna:c1" });
    expect(homeIntent(HOME, onWaiting, { name: "return" })).toEqual({
      kind: "answer",
      value: "open:luna:c1",
    });
    expect(homeIntent(HOME, onWaiting, { name: "h", sequence: "h" })).toMatchObject({
      patch: { waitingValue: undefined },
      edit: true,
    });
    expect(enterHint(HOME, onWaiting)).toBe("enter opens Wedding venue");
    expect(enterHint(HOME, at({}))).toBe("enter sends to sol");
  });

  it("slash commands run from the composer and never start a conversation", () => {
    expect(homeCommandMatches(HOME, "/re")?.map((command) => command.name)).toEqual(["resume"]);
    expect(homeIntent(HOME, at({ draft: "/re" }), { name: "return" })).toEqual({
      kind: "answer",
      value: "resume-conversation",
    });
    expect(homeIntent(HOME, at({ draft: "/resume now" }), { name: "return" })).toEqual({
      kind: "answer",
      value: "resume-conversation",
    });
    expect(homeIntent(HOME, at({ draft: "/nope" }), { name: "return" })).toMatchObject({
      kind: "state",
      edit: false,
    });
    expect(homeIntent(HOME, at({ draft: "/" }), { name: "down" })).toEqual({
      kind: "state",
      patch: { commandIndex: 1 },
      edit: false,
    });
    expect(homeIntent(HOME, at({ draft: "/se" }), { name: "tab" })).toEqual({
      kind: "state",
      patch: { draft: "/settings", commandIndex: 0 },
      edit: false,
    });
    expect(enterHint(HOME, at({ draft: "/qu" }))).toBe("enter runs /quit");
  });

  it("tab opens every agent and keeps the draft", () => {
    expect(homeIntent(HOME, at({ draft: "hi" }), { name: "tab" })).toEqual({
      kind: "answer",
      value: "pick-agent",
      text: "hi",
    });
  });

  it("esc clears a draft first, then quits; ctrl+c quits", () => {
    expect(homeIntent(HOME, at({ draft: "draft" }), { name: "escape" })).toEqual({
      kind: "state",
      patch: { draft: "", commandIndex: 0 },
      edit: false,
    });
    expect(homeIntent(HOME, at({}), { name: "escape" })).toEqual({ kind: "quit" });
    expect(homeIntent(HOME, at({ draft: "x" }), { name: "c", ctrl: true })).toEqual({
      kind: "quit",
    });
  });

  it("first run chooses from its list with the arrows", () => {
    const firstRun: HomeModel = {
      ...HOME,
      agents: [],
      firstRun: {
        detected: [],
        actions: [
          { label: "Start setup", value: "create-agent" },
          { label: "Settings", value: "settings" },
        ],
      },
    };
    expect(homeIntent(firstRun, at({}), { name: "down" })).toMatchObject({
      patch: { commandIndex: 1 },
    });
    expect(homeIntent(firstRun, at({ commandIndex: 1 }), { name: "return" })).toEqual({
      kind: "answer",
      value: "settings",
    });
    expect(homeIntent(firstRun, at({}), { name: "s", sequence: "s" })).toMatchObject({
      edit: false,
    });
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

  it("drops a bracket that was cut off before it closed", () => {
    expect(
      readableTitle({
        conversationTitle: "Reply with exactly one word: hello [memory recall",
        agentName: "sol",
      }),
    ).toBe("Reply with exactly one word: hello");
  });

  it("keeps a first line under a short limit for lists", () => {
    expect(
      briefDetail("The accepted plan starts with a read-only inventory of ~/Downloads", 30),
    ).toBe("The accepted plan starts…");
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
    const sentences = homeSentences(HOME, EMPTY);
    expect(sentences.start).toBe("New conversation with sol (gpt-5.6-sol)");
    expect(sentences.agents[1]?.text).toBe("luna, gpt-5.6-luna, default, used 2h ago");
    expect(sentences.agents[2]?.text).toBe("coder-terra, gpt-5.6-sol, coder, not used yet");
    expect(sentences.waiting[0]?.text).toBe("Wedding venue, luna, asked you 1d ago");
    expect(sentences.footer).toBe("/ commands · ↓ waiting · tab all agents · esc quit");
  });

  it("renders the same content on the Ink path", () => {
    const text = renderToString(
      <InkHome
        model={HOME}
        onAnswer={() => undefined}
        onQuit={() => undefined}
      />,
      { columns: 100 },
    );
    expect(text).toContain("› New conversation with sol (gpt-5.6-sol)");
    expect(text).toContain("Type / for commands, or type your first message:");
    expect(text).toContain("Your agents, 31");
    expect(text).toContain("Waiting for you, 1");
    expect(text).toContain("/ commands · ↓ waiting · tab all agents · esc quit");
  });
});
