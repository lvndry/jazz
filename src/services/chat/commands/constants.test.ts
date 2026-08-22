import { afterEach, describe, expect, it } from "bun:test";
import { filterCommandsByPrefix, setSkillCommands, slashCommandQuery } from "./constants";

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
