import type { Agent } from "@jazz/core/types/index";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { selectAgentForWorkflow } from "./workflow";
import { store } from "../ui/store";

function agent(partial: {
  readonly id: string;
  readonly name: string;
  readonly model: string;
}): Agent {
  return {
    id: partial.id,
    name: partial.name,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    config: {
      persona: "default",
      llmProvider: "anthropic",
      llmModel: partial.model,
    },
  };
}

describe("selectAgentForWorkflow", () => {
  it("publishes a data-only agent menu instead of an Ink tree", async () => {
    store.setActiveMenu(null);
    const agents = [
      agent({ id: "a1", name: "reviewer", model: "claude-sonnet-4" }),
      agent({ id: "a2", name: "coder", model: "qwen2.5-coder" }),
    ];

    const selected = Effect.runPromise(
      selectAgentForWorkflow(agents, "Select an agent to run this workflow:"),
    );
    const menu = store.getActiveMenuSnapshot();

    expect(menu?.kind).toBe("agents");
    if (menu?.kind !== "agents") {
      throw new Error("expected an agents menu");
    }
    expect(menu).not.toHaveProperty("onSelect");
    expect(menu).not.toHaveProperty("onExit");
    expect(menu.title).toBe("Select an agent to run this workflow:");
    expect(menu.action).toBe("run");
    expect(menu.agents.map((choice) => choice.id)).toEqual(["a1", "a2"]);

    store.completePrompt({ kind: "select", value: "a2" });
    await expect(selected).resolves.toMatchObject({ id: "a2", name: "coder" });
    expect(store.getActiveMenuSnapshot()).toBe(null);
  });

  it("returns null when the picker is dismissed", async () => {
    store.setActiveMenu(null);
    const selected = Effect.runPromise(
      selectAgentForWorkflow(
        [agent({ id: "a1", name: "reviewer", model: "claude-sonnet-4" })],
        "Select an agent to run this scheduled workflow:",
      ),
    );

    store.completePrompt({ kind: "exit" });
    await expect(selected).resolves.toBe(null);
    expect(store.getActiveMenuSnapshot()).toBe(null);
  });
});
