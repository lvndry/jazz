import { afterEach, describe, expect, it } from "bun:test";
import {
  commandUsage,
  filterCommandsByPrefix,
  findBuiltinCommand,
  findCommand,
  isExitCommand,
  setPluginCommands,
  setSkillCommands,
  slashCommandQuery,
  suggestCommand,
} from "./constants";

describe("slashCommandQuery", () => {
  it("reads the prefix until arguments or a newline start", () => {
    expect(slashCommandQuery("/")).toBe("");
    expect(slashCommandQuery("/hel")).toBe("hel");
    expect(slashCommandQuery("/help extra")).toBeNull();
    expect(slashCommandQuery("/help\n")).toBeNull();
    expect(slashCommandQuery("help")).toBeNull();
  });
});

describe("filterCommandsByPrefix", () => {
  afterEach(() => {
    setSkillCommands([]);
  });

  it("returns built-in commands when no skills are registered", () => {
    const results = filterCommandsByPrefix("hel");
    expect(results.some((cmd) => cmd.name === "help")).toBe(true);
    expect(results.every((cmd) => cmd.source !== "skill")).toBe(true);
  });

  it("includes registered skills in the suggestion list", () => {
    setSkillCommands([{ name: "deep-research", description: "Research a topic" }]);
    const results = filterCommandsByPrefix("deep");
    const skill = results.find((cmd) => cmd.name === "deep-research");
    expect(skill).toBeDefined();
    expect(skill?.source).toBe("skill");
  });

  it("ranks built-in commands before skills for the same prefix", () => {
    setSkillCommands([{ name: "modeling", description: "a skill starting with mode" }]);
    const results = filterCommandsByPrefix("mode");
    const builtinIndex = results.findIndex((cmd) => cmd.name === "mode");
    const skillIndex = results.findIndex((cmd) => cmd.name === "modeling");
    expect(builtinIndex).toBeGreaterThanOrEqual(0);
    expect(skillIndex).toBeGreaterThan(builtinIndex);
  });

  it("drops skills whose name collides with a built-in command", () => {
    setSkillCommands([{ name: "help", description: "colliding skill" }]);
    const results = filterCommandsByPrefix("help");
    const helpEntries = results.filter((cmd) => cmd.name === "help");
    expect(helpEntries).toHaveLength(1);
    expect(helpEntries[0]?.source).not.toBe("skill");
  });
});

describe("command lookup", () => {
  afterEach(() => {
    setSkillCommands([]);
    setPluginCommands([]);
  });

  it("finds a built-in by alias, with or without the slash", () => {
    expect(findBuiltinCommand("/stats")?.name).toBe("info");
    expect(findBuiltinCommand("QUIT")?.name).toBe("exit");
  });

  it("finds registered commands too", () => {
    setSkillCommands([{ name: "deep-research", description: "Research a topic" }]);
    expect(findCommand("deep-research")?.source).toBe("skill");
  });

  it("suggests the closest command for a typo, and nothing for noise", () => {
    expect(suggestCommand("halp")?.name).toBe("help");
    expect(suggestCommand("/resum")?.name).toBe("resume");
    expect(suggestCommand("xyzzyplugh")).toBeUndefined();
  });

  it("keeps aliases from being taken by skills or plugins", () => {
    setSkillCommands([{ name: "quit", description: "a skill named like an alias" }]);
    setPluginCommands([{ name: "stats", description: "a plugin named like an alias" }]);
    expect(findCommand("quit")?.source).toBeUndefined();
    expect(findCommand("stats")?.source).toBeUndefined();
  });

  it("autocompletes by alias", () => {
    expect(filterCommandsByPrefix("stat").some((command) => command.name === "info")).toBe(true);
  });
});

describe("isExitCommand", () => {
  it("ends the chat only on /exit or its alias", () => {
    expect(isExitCommand("/exit")).toBe(true);
    expect(isExitCommand("  /QUIT ")).toBe(true);
    expect(isExitCommand("exit")).toBe(false);
    expect(isExitCommand("quit")).toBe(false);
    expect(isExitCommand("/exit now")).toBe(false);
  });
});

describe("commandUsage", () => {
  it("lists every form of a command with its meaning and ends with its note", () => {
    const loop = findBuiltinCommand("loop");
    if (loop === undefined) {
      throw new Error("/loop is registered");
    }
    const usage = commandUsage(loop);
    expect(usage.label).toBe("/loop");
    expect(usage.rows).toEqual(
      (loop.forms ?? []).map((entry) => ({
        kind: "item",
        name: entry.form,
        detail: entry.meaning,
      })),
    );
    expect(usage.note).toContain("jazz daemon");
  });
});
