import { afterEach, describe, expect, it } from "bun:test";
import { store } from "./store";
import { pickThemeInteractively } from "./theme-picker-prompt";
import type { PromptState } from "./types";

describe("pickThemeInteractively", () => {
  afterEach(() => {
    store.setPrompt(null);
  });

  const chatPrompt: PromptState = { type: "chat", message: "You:", resolve: () => undefined };

  it("hands the idle chat prompt back when the picker is dismissed", async () => {
    store.setPrompt(chatPrompt);
    const chosen = pickThemeInteractively();
    expect(store.getPromptSnapshot()?.type).toBe("theme");

    store.getPromptSnapshot()?.reject?.();
    expect(await chosen).toBeUndefined();
    expect(store.getPromptSnapshot()).toBe(chatPrompt);
  });

  it("hands the chat prompt back after a choice", async () => {
    store.setPrompt(chatPrompt);
    const chosen = pickThemeInteractively();

    store.getPromptSnapshot()?.resolve("jazz:dark");
    expect(await chosen).toBe("jazz:dark");
    expect(store.getPromptSnapshot()).toBe(chatPrompt);
  });

  it("gives way to a prompt the session needs and leaves that prompt up", async () => {
    store.setPrompt(null);
    const chosen = pickThemeInteractively();

    store.setPrompt(chatPrompt);
    expect(await chosen).toBeUndefined();
    expect(store.getPromptSnapshot()).toBe(chatPrompt);
  });
});
