import { report, type TerminalService } from "@jazz/core/interfaces/terminal";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { store } from "@/cli/ui/store";
import { commandPanelTerminal, runsImmediately } from "./immediate";
import { parseSpecialCommand } from "./parser";

function immediate(text: string): boolean {
  return runsImmediately(parseSpecialCommand(text));
}

describe("runsImmediately", () => {
  it("runs commands that only read", () => {
    for (const text of ["/info", "/cost", "/context", "/help", "/help mcp", "/tools", "/peers"]) {
      expect(immediate(text)).toBe(true);
    }
  });

  it("runs /theme, with or without a name", () => {
    expect(immediate("/theme")).toBe(true);
    expect(immediate("/theme jazz dark")).toBe(true);
  });

  it("runs the reading forms of commands that also change things", () => {
    expect(immediate("/mcp")).toBe(true);
    expect(immediate("/work")).toBe(true);
    expect(immediate("/memory")).toBe(true);
    expect(immediate("/memory personal/notes.md")).toBe(true);
    expect(immediate("/waits")).toBe(true);
    expect(immediate("/waits list")).toBe(true);
  });

  it("leaves the changing forms to the queue", () => {
    expect(immediate("/mcp reconnect github")).toBe(false);
    expect(immediate("/work clear")).toBe(false);
    expect(immediate("/memory forget personal/notes.md")).toBe(false);
    expect(immediate("/waits cancel 1")).toBe(false);
  });

  it("leaves commands that change the conversation or agent to the queue", () => {
    for (const text of [
      "/compact",
      "/new",
      "/model",
      "/mode yolo",
      "/switch",
      "/agents",
      "/exit",
    ]) {
      expect(immediate(text)).toBe(false);
    }
  });
});

describe("commandPanelTerminal", () => {
  afterEach(() => {
    store.closeCommandPanel();
  });

  const asked: string[] = [];
  const ask = (message: string) => Effect.sync(() => (asked.push(message), "answer"));
  const base = new Proxy({} as TerminalService, {
    get: (_target, key) =>
      key === "isInteractive" ? true : key === "ask" ? ask : () => Effect.void,
  });

  it("sends reports and messages to the panel, in order", () => {
    const terminal = commandPanelTerminal(base, "/info");
    Effect.runSync(terminal.log(report("info", [{ kind: "field", key: "model", value: "x" }])));
    Effect.runSync(terminal.warn("careful"));

    const panel = store.getCommandPanelSnapshot();
    expect(panel?.command).toBe("/info");
    expect(panel?.entries.map((entry) => entry.kind)).toEqual(["report", "text"]);
    expect(panel?.entries[1]).toEqual({ kind: "text", tone: "warn", text: "careful" });
  });

  it("asks through the terminal it wraps", () => {
    const terminal = commandPanelTerminal(base, "/theme");
    expect(Effect.runSync(terminal.ask("Theme?"))).toBe("answer");
    expect(asked).toEqual(["Theme?"]);
    expect(store.getCommandPanelSnapshot()).toBeNull();
  });
});
