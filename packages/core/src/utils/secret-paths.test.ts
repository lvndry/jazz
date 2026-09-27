import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSecretResultFilter, loadSecretPathRules, secretPathReason } from "./secret-paths";

let root: string;
let home: string;
let jazzHome: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-secret-paths-")));
  home = path.join(root, "home");
  jazzHome = path.join(home, ".jazz");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(jazzHome, { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
  fs.writeFileSync(path.join(jazzHome, "secrets.json"), "{}");
  fs.writeFileSync(path.join(home, "notes.md"), "hello");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadSecretPathRules", () => {
  it("refuses Jazz's own secrets and the stores other programs keep", () => {
    const rules = loadSecretPathRules({ home, jazzHome, platform: "linux" });
    for (const secret of [
      path.join(jazzHome, "secrets.json"),
      path.join(jazzHome, "config.json"),
      path.join(jazzHome, "daemon.token"),
      path.join(jazzHome, ".secrets.lock"),
      path.join(jazzHome, ".secrets-123-abc.tmp"),
      path.join(home, ".ssh"),
      path.join(home, ".ssh", "id_ed25519"),
      path.join(home, ".aws", "credentials"),
      path.join(home, ".gnupg", "private-keys-v1.d", "key"),
      path.join(home, ".netrc"),
      path.join(home, ".agents", "mcp.json"),
      "/proc/self/environ",
      "/proc/1234/environ",
      "/proc/1234/task/5678/environ",
    ]) {
      expect(rules.reasonFor(secret)).toBeString();
    }
  });

  it("leaves ordinary files alone", () => {
    const rules = loadSecretPathRules({ home, jazzHome, platform: "linux" });
    for (const ordinary of [
      path.join(home, "notes.md"),
      path.join(home, ".sshrc"),
      path.join(home, ".aws", "config"),
      path.join(jazzHome, "agents", "default.json"),
      path.join(jazzHome, "history", "a.json"),
      "/proc/self/status",
    ]) {
      expect(rules.reasonFor(ordinary)).toBeUndefined();
    }
  });

  it("compares case-insensitively on macOS", () => {
    const darwin = loadSecretPathRules({ home, jazzHome, platform: "darwin" });
    const linux = loadSecretPathRules({ home, jazzHome, platform: "linux" });
    const shouted = path.join(home, ".SSH", "id_ed25519");
    expect(darwin.reasonFor(shouted)).toBeString();
    expect(linux.reasonFor(shouted)).toBeUndefined();
  });
});

describe("secretPathReason", () => {
  it("follows symlinks to a secret", () => {
    const rules = loadSecretPathRules({ home, jazzHome, platform: "linux" });
    const link = path.join(home, "innocent.txt");
    fs.symlinkSync(path.join(home, ".ssh", "id_ed25519"), link);
    expect(rules.reasonFor(link)).toBeUndefined();
    expect(secretPathReason(link, rules)).toBe("SSH keys");
  });

  it("matches a secret reached through a symlinked JAZZ_HOME", () => {
    const linkedHome = path.join(root, "linked-jazz");
    fs.symlinkSync(jazzHome, linkedHome);
    const rules = loadSecretPathRules({ home, jazzHome: linkedHome, platform: "linux" });
    expect(rules.reasonFor(path.join(jazzHome, "secrets.json"))).toBeString();
    expect(rules.reasonFor(path.join(linkedHome, "secrets.json"))).toBeString();
  });
});

describe("createSecretResultFilter", () => {
  it("drops results under a secret directory, including through a symlinked search root", () => {
    const rules = loadSecretPathRules({ home, jazzHome, platform: "linux" });
    const linkedRoot = path.join(root, "home-link");
    fs.symlinkSync(home, linkedRoot);
    const isSecret = createSecretResultFilter(linkedRoot, rules);
    expect(isSecret(path.join(linkedRoot, ".ssh", "id_ed25519"))).toBe(true);
    expect(isSecret(".ssh/id_ed25519")).toBe(true);
    expect(isSecret(path.join(linkedRoot, "notes.md"))).toBe(false);
  });
});
