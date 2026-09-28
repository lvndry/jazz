import { describe, expect, it } from "bun:test";
import { renderToString } from "ink";
import React from "react";
import {
  conversationTag,
  detectionLines,
  homeLead,
  homeLegend,
  statusText,
  type HomeModel,
} from "./home-view";
import { InkHome, inkHomeOptions } from "../InkHome";

const HOME: HomeModel = {
  version: "0.14.2",
  cwd: "~/work",
  greeting: "Good morning.",
  conversations: [
    {
      key: "1",
      value: "open:a1:c1",
      title: "Wedding planning",
      agent: "Basil",
      detail: "goal venue waiting for your answer",
      age: "9m ago",
      waiting: true,
    },
    {
      key: "2",
      value: "open:a2:c2",
      title: "Weekly review",
      agent: "Cass",
      detail: "14 messages",
      age: "1d ago",
      waiting: false,
    },
  ],
  actions: [
    { key: "enter", label: "new conversation with Basil", value: "new-conversation" },
    { key: "n", label: "new agent", value: "create-agent" },
    { key: "q", label: "quit", value: "exit" },
  ],
  status: [
    { text: "4 agents" },
    { text: "no model provider has a key", tone: "warning", fixKey: "s" },
  ],
};

describe("home view model", () => {
  it("leads with the count of waiting conversations", () => {
    expect(homeLead(HOME)).toBe("1 conversation is waiting for you.");
    expect(homeLead({ ...HOME, conversations: HOME.conversations.slice(1) })).toBe(
      "Pick up where you left off, or start something new.",
    );
    expect(homeLead({ ...HOME, conversations: [] })).toBe("");
  });

  it("tags a waiting conversation and leaves the others with their age", () => {
    expect(conversationTag(HOME.conversations[0]!)).toBe("waiting · 9m ago");
    expect(conversationTag(HOME.conversations[1]!)).toBe("1d ago");
  });

  it("puts enter and the number keys first in the legend", () => {
    expect(homeLegend(HOME)).toEqual({
      primary: [
        { key: "enter", label: "new conversation with Basil" },
        { key: "1–2", label: "open one" },
      ],
      rest: [
        { key: "n", label: "new agent" },
        { key: "q", label: "quit" },
      ],
    });
  });

  it("reads first-run detections as one sentence, and the status with its fix key", () => {
    expect(
      detectionLines({
        ...HOME,
        firstRun: {
          detected: [
            { label: "OPENAI_API_KEY", detail: "in your environment" },
            { label: "Ollama", detail: "running" },
          ],
        },
      }).map((line) => line.lead),
    ).toEqual(["Found", "and"]);
    expect(statusText(HOME.status, " · ")).toBe(
      "4 agents · no model provider has a key (s to fix)",
    );
  });
});

describe("Ink home", () => {
  it("lists conversations, then actions, each with the key the fullscreen legend uses", () => {
    expect(inkHomeOptions(HOME).map((option) => option.value)).toEqual([
      "open:a1:c1",
      "open:a2:c2",
      "new-conversation",
      "create-agent",
      "exit",
    ]);
    expect(inkHomeOptions(HOME)[0]?.label).toBe("1  Wedding planning · Basil · waiting · 9m ago");
  });

  it("reads the same content as the fullscreen screen", () => {
    const text = renderToString(
      <InkHome
        model={HOME}
        onSelect={() => undefined}
        onExit={() => undefined}
      />,
      { columns: 100 },
    );
    expect(text).toContain("Good morning. 1 conversation is waiting for you.");
    expect(text).toContain("Wedding planning · Basil · waiting · 9m ago");
    expect(text).toContain("new conversation with Basil");
    expect(text).toContain("no model provider has a key (s to fix)");
  });
});
