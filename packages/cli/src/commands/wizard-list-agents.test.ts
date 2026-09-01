import type { Agent } from "@jazz/core/types/index";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { showAgentList } from "./wizard";
import { store } from "../ui/store";

function agent(partial: {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly description?: string;
}): Agent {
  return {
    id: partial.id,
    name: partial.name,
    ...(partial.description === undefined ? {} : { description: partial.description }),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    config: {
      persona: "default",
      llmProvider: "anthropic",
      llmModel: partial.model,
    },
  };
}

describe("showAgentList", () => {
  it("publishes every agent to the fullscreen menu instead of an empty list", async () => {
    store.setActiveMenu(null);

    const agents = [
      agent({ id: "a2", name: "qwen-coder", model: "qwen2.5-coder" }),
      agent({
        id: "a1",
        name: "doitall",
        model: "claude-sonnet-4",
        description: "does everything",
      }),
    ];

    const listed = Effect.runPromise(showAgentList(agents, "a1"));
    const menu = store.getActiveMenuSnapshot();

    expect(menu?.kind).toBe("agents");
    if (menu?.kind !== "agents") {
      throw new Error("expected an agents menu");
    }
    expect(menu).not.toHaveProperty("onSelect");
    expect(menu).not.toHaveProperty("onExit");
    expect(menu.title).toBe("agents");
    expect(menu.action).toBe("back");
    expect(menu.browse).toBe(true);
    expect(menu.agents).toHaveLength(2);
    expect(menu.agents.map((choice) => choice.name)).toEqual(["doitall", "qwen-coder"]);
    expect(menu.agents[0]).toMatchObject({
      id: "a1",
      name: "doitall",
      model: "anthropic/claude-sonnet-4",
      description: "does everything",
      lastUsed: true,
    });
    expect(menu.agents[1]).toMatchObject({
      id: "a2",
      name: "qwen-coder",
      model: "anthropic/qwen2.5-coder",
    });

    store.completePrompt({ kind: "exit" });
    await listed;
    expect(store.getActiveMenuSnapshot()).toBe(null);
  });

  it("still publishes a list screen when storage returns no agents", async () => {
    store.setActiveMenu(null);
    const listed = Effect.runPromise(showAgentList([], null));
    const menu = store.getActiveMenuSnapshot();
    expect(menu?.kind).toBe("agents");
    if (menu?.kind !== "agents") {
      throw new Error("expected an agents menu");
    }
    expect(menu.agents).toEqual([]);
    expect(menu.browse).toBe(true);
    expect(menu).not.toHaveProperty("onSelect");
    store.completePrompt({ kind: "exit" });
    await listed;
    expect(store.getActiveMenuSnapshot()).toBe(null);
  });
});
