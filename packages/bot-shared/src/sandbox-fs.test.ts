import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readAgentFile, writeAgentFile } from "./agent-file";
import { readReminders } from "./reminder-store";
import { openDirectory, withDirectory } from "./sandbox-fs";

let root: string;
let home: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sandbox-fs-"));
  home = join(root, "home");
  outside = join(root, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.json"), '{"owner":"someone else"}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a name the conversation swapped for a link", () => {
  test("is read as absent rather than followed", () => {
    symlinkSync(join(outside, "secret.json"), join(home, "config.json"));
    withDirectory(home, {}, (directory) => {
      expect(directory.readText("config.json")).toBeUndefined();
    });
  });

  test("is replaced by a write, and the file it pointed at is untouched", () => {
    symlinkSync(join(outside, "secret.json"), join(home, "config.json"));
    withDirectory(home, {}, (directory) => {
      directory.writeBytes("config.json", "{}\n", { mode: 0o600 });
    });
    expect(lstatSync(join(home, "config.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(outside, "secret.json"), "utf8")).toBe('{"owner":"someone else"}');
  });

  test("is replaced by a real directory when the bridge creates one there", () => {
    symlinkSync(outside, join(home, "agents"));
    withDirectory(home, {}, (directory) => {
      const agents = directory.directory("agents", { create: { mode: 0o750 } });
      agents.writeBytes("tg_1.json", "{}\n", { mode: 0o640 });
      agents.close();
    });
    expect(lstatSync(join(home, "agents")).isDirectory()).toBe(true);
    expect(() => lstatSync(join(outside, "tg_1.json"))).toThrow();
  });

  test("is refused as a directory when the bridge only reads", () => {
    symlinkSync(outside, join(home, "agents"));
    withDirectory(home, {}, (directory) => {
      expect(() => directory.directory("agents")).toThrow();
    });
  });

  test("is refused as a new append-only file", () => {
    symlinkSync(join(outside, "secret.json"), join(home, "run.ndjson"));
    withDirectory(home, {}, (directory) => {
      expect(() => directory.createAppendOnly("run.ndjson", 0o600)).toThrow();
    });
  });

  test("is unlinked on removal, leaving its target alone", () => {
    symlinkSync(join(outside, "secret.json"), join(home, "old.ogg"));
    withDirectory(home, {}, (directory) => directory.remove("old.ogg"));
    expect(() => lstatSync(join(home, "old.ogg"))).toThrow();
    expect(readFileSync(join(outside, "secret.json"), "utf8")).toBe('{"owner":"someone else"}');
  });

  test("refuses names that climb out of the directory", () => {
    withDirectory(home, {}, (directory) => {
      expect(() => directory.writeBytes("../escape", "x", { mode: 0o600 })).toThrow();
      expect(() => directory.readText("..")).toThrow();
    });
  });
});

describe.if(process.platform === "linux")("a pinned directory", () => {
  test("keeps writing into the directory it opened after the name is swapped", () => {
    mkdirSync(join(home, "media"));
    const media = openDirectory(home).directory("media");
    renameSync(join(home, "media"), join(home, "moved"));
    symlinkSync(outside, join(home, "media"));
    media.writeBytes("voice.ogg", "bytes", { mode: 0o640 });
    media.close();
    expect(readFileSync(join(home, "moved", "voice.ogg"), "utf8")).toBe("bytes");
    expect(() => lstatSync(join(outside, "voice.ogg"))).toThrow();
  });
});

describe("the stores built on it", () => {
  test("an agent written into a linked agents directory lands in the home", () => {
    symlinkSync(outside, join(home, "agents"));
    writeAgentFile(home, {
      id: "tg_1",
      name: "Jazz",
      config: { llmProvider: "openai", llmModel: "gpt", reasoning: "low", persona: "default" },
    });
    expect(readAgentFile(home, "tg_1").name).toBe("Jazz");
    expect(() => lstatSync(join(outside, "tg_1.json"))).toThrow();
  });

  test("a reminder file linked to another conversation's reads as empty", () => {
    mkdirSync(join(home, "reminders"));
    writeFileSync(
      join(outside, "tg_2.json"),
      JSON.stringify([{ id: "a", fireAt: 1, text: "their dentist", createdAt: 0 }]),
    );
    symlinkSync(join(outside, "tg_2.json"), join(home, "reminders", "tg_1.json"));
    expect(readReminders(home, "tg_1")).toEqual([]);
  });
});
