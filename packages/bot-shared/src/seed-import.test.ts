import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { describe, expect, test } from "bun:test";
import { agentStoreDirectory, importSeedAgent, listAgents, matchAgent } from "./seed-import";

function home(agents: readonly { id: string; name: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "jazz-seed-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  for (const agent of agents) {
    writeFileSync(
      join(dir, "agents", `${agent.id}.json`),
      JSON.stringify({ id: agent.id, name: agent.name, config: {} }),
    );
  }
  return dir;
}

describe("listAgents", () => {
  test("reads id and name off every agent", () => {
    const dir = home([{ id: "a1", name: "nostra" }]);
    expect(listAgents(dir)).toEqual([{ id: "a1", name: "nostra" }]);
  });

  test("an empty home is a fresh install, not an error", () => {
    expect(listAgents(mkdtempSync(join(tmpdir(), "jazz-empty-")))).toEqual([]);
  });

  test("skips a file that will not parse rather than failing the whole list", () => {
    const dir = home([{ id: "a1", name: "nostra" }]);
    writeFileSync(join(dir, "agents", "broken.json"), "{ not json");
    expect(listAgents(dir)).toEqual([{ id: "a1", name: "nostra" }]);
  });
});

describe("matchAgent", () => {
  const agents = [
    { id: "6z8mJdm", name: "nostra" },
    { id: "aLpCqRk", name: "excel-analyzer" },
  ];

  test("finds by id", () => {
    expect(matchAgent(agents, "6z8mJdm")).toEqual({ kind: "found", id: "6z8mJdm" });
  });

  test("finds by name, whatever the case", () => {
    expect(matchAgent(agents, "Nostra")).toEqual({ kind: "found", id: "6z8mJdm" });
  });

  test("prefers an id over a name, since only the id is unique", () => {
    const clash = [
      { id: "nostra", name: "excel-analyzer" },
      { id: "other", name: "nostra" },
    ];
    expect(matchAgent(clash, "nostra")).toEqual({ kind: "found", id: "nostra" });
  });

  test("reports a shared name instead of picking one at random", () => {
    const twins = [
      { id: "a1", name: "nostra" },
      { id: "a2", name: "nostra" },
    ];
    expect(matchAgent(twins, "nostra").kind).toBe("ambiguous");
  });

  test("misses cleanly on something that is neither", () => {
    expect(matchAgent(agents, "nope")).toEqual({ kind: "missing" });
  });
});

describe("importSeedAgent", () => {
  test("copies the agent into the bridge home", () => {
    const source = home([{ id: "a1", name: "nostra" }]);
    const target = mkdtempSync(join(tmpdir(), "jazz-bridge-"));

    expect(importSeedAgent(source, target, "a1")).toBe(true);
    const copied = JSON.parse(readFileSync(join(target, "agents", "a1.json"), "utf8")) as {
      name: string;
    };
    expect(copied.name).toBe("nostra");
  });

  test("leaves an existing seed alone, which holds choices made from a phone", () => {
    const source = home([{ id: "a1", name: "nostra" }]);
    const target = home([{ id: "a1", name: "renamed in Messages" }]);

    expect(importSeedAgent(source, target, "a1")).toBe(false);
    const kept = JSON.parse(readFileSync(join(target, "agents", "a1.json"), "utf8")) as {
      name: string;
    };
    expect(kept.name).toBe("renamed in Messages");
  });

  test("does nothing when both homes are the same directory", () => {
    const dir = home([{ id: "a1", name: "nostra" }]);
    expect(importSeedAgent(dir, dir, "a1")).toBe(false);
  });

  test("does nothing when there is no such agent to copy", () => {
    const source = home([]);
    const target = mkdtempSync(join(tmpdir(), "jazz-bridge-"));
    expect(importSeedAgent(source, target, "missing")).toBe(false);
  });
});

describe("agentStoreDirectory", () => {
  const withConfig = (config: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "jazz-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    const previous = process.env["JAZZ_CONFIG_PATH"];
    process.env["JAZZ_CONFIG_PATH"] = path;
    try {
      return agentStoreDirectory();
    } finally {
      if (previous === undefined) delete process.env["JAZZ_CONFIG_PATH"];
      else process.env["JAZZ_CONFIG_PATH"] = previous;
    }
  };

  test("follows storage.path, which is where the agents actually are", () => {
    expect(withConfig({ storage: { type: "file", path: "/somewhere/else/.jazz" } })).toBe(
      "/somewhere/else/.jazz",
    );
  });

  test("falls back to the Jazz home when storage names no path", () => {
    expect(withConfig({ storage: { type: "file", path: "" } })).toBe(getJazzHomeDirectory());
  });

  test("falls back when there is no storage stanza at all", () => {
    expect(withConfig({ logging: { level: "debug" } })).toBe(getJazzHomeDirectory());
  });

  test("falls back rather than throwing on an unreadable config", () => {
    const previous = process.env["JAZZ_CONFIG_PATH"];
    process.env["JAZZ_CONFIG_PATH"] = join(tmpdir(), "jazz-does-not-exist", "config.json");
    try {
      expect(agentStoreDirectory()).toBe(getJazzHomeDirectory());
    } finally {
      if (previous === undefined) delete process.env["JAZZ_CONFIG_PATH"];
      else process.env["JAZZ_CONFIG_PATH"] = previous;
    }
  });
});
