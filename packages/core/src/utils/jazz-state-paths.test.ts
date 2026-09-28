import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { jazzStateChangeReason } from "./jazz-state-paths";

describe("jazzStateChangeReason", () => {
  let root: string;
  let jazzHome: string;
  const savedHome = process.env["JAZZ_HOME"];
  const savedConfigPath = process.env["JAZZ_CONFIG_PATH"];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "jazz-state-")));
    jazzHome = join(root, "home");
    mkdirSync(join(jazzHome, "skills"), { recursive: true });
    process.env["JAZZ_HOME"] = jazzHome;
    delete process.env["JAZZ_CONFIG_PATH"];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = savedHome;
    }
    if (savedConfigPath === undefined) {
      delete process.env["JAZZ_CONFIG_PATH"];
    } else {
      process.env["JAZZ_CONFIG_PATH"] = savedConfigPath;
    }
  });

  it("flags the config file and Jazz's own state", () => {
    expect(jazzStateChangeReason(join(jazzHome, "config.json"))).toContain("config file");
    expect(jazzStateChangeReason(join(jazzHome, "command-approvals.json"))).toContain("state");
    expect(jazzStateChangeReason(join(jazzHome, "agents", "default.json"))).toContain("state");
  });

  it("flags a target that contains Jazz's home", () => {
    expect(jazzStateChangeReason(jazzHome)).toBeDefined();
    expect(jazzStateChangeReason(root)).toBeDefined();
  });

  it("leaves authored content and unrelated paths alone", () => {
    expect(jazzStateChangeReason(join(jazzHome, "skills", "mine", "SKILL.md"))).toBeUndefined();
    expect(jazzStateChangeReason(join(jazzHome, "workspace", "notes.md"))).toBeUndefined();
    expect(jazzStateChangeReason(join(root, "project", "config.json"))).toBeUndefined();
  });

  it("follows JAZZ_CONFIG_PATH outside the home", () => {
    const override = join(root, "elsewhere", "jazz.json");
    process.env["JAZZ_CONFIG_PATH"] = override;
    expect(jazzStateChangeReason(override)).toContain("config file");
  });

  it("sees the config through a symlinked directory", () => {
    const alias = join(root, "alias");
    symlinkSync(jazzHome, alias);
    expect(jazzStateChangeReason(join(alias, "config.json"))).toBeDefined();
    expect(jazzStateChangeReason(join(alias, "skills", "x.md"))).toBeUndefined();
  });

  it("ignores case on case-insensitive platforms", () => {
    const shouted = join(jazzHome.toUpperCase(), "CONFIG.JSON");
    expect(jazzStateChangeReason(shouted, { platform: "darwin" })).toBeDefined();
    expect(
      jazzStateChangeReason(join(jazzHome, "SKILLS", "x.md"), { platform: "darwin" }),
    ).toBeUndefined();
  });
});
