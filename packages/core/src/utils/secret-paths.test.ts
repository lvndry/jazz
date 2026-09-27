/** Credential path rules cover direct names, aliases, and internal replacement trees. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSecretResultFilter, loadSecretPathRules, secretPathReason } from "./secret-paths";

let root: string;
let jazzHome: string;
let previousJazzHome: string | undefined;
let previousConfigPath: string | undefined;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-secret-paths-")));
  jazzHome = path.join(root, "jazz-home");
  fs.mkdirSync(path.join(jazzHome, "history"), { recursive: true });
  fs.writeFileSync(path.join(jazzHome, "secrets.json"), "{}");
  fs.writeFileSync(path.join(jazzHome, "notes.md"), "hello");
  previousJazzHome = process.env["JAZZ_HOME"];
  previousConfigPath = process.env["JAZZ_CONFIG_PATH"];
  process.env["JAZZ_HOME"] = jazzHome;
  delete process.env["JAZZ_CONFIG_PATH"];
});

afterEach(() => {
  restore("JAZZ_HOME", previousJazzHome);
  restore("JAZZ_CONFIG_PATH", previousConfigPath);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadSecretPathRules", () => {
  it("refuses Jazz's own secret files and their lock and temp siblings", () => {
    const rules = loadSecretPathRules({ platform: "linux" });
    for (const secret of [
      path.join(jazzHome, "secrets.json"),
      path.join(jazzHome, "config.json"),
      path.join(jazzHome, ".secrets.lock"),
      path.join(jazzHome, ".secrets.lock", "inner"),
      path.join(jazzHome, ".secrets-123-abc.tmp"),
      path.join(jazzHome, ".secrets.json-123-abc.tmp"),
      path.join(jazzHome, ".config.json-123-abc.tmp"),
      path.join(jazzHome, "secrets.json.corrupt-2026-09-27"),
      path.join(jazzHome, "config.json.corrupt-2026-09-27"),
      path.join(jazzHome, ".chatgpt-credential.lock"),
      path.join(root, ".env"),
      path.join(root, ".env.local"),
      path.join(root, "secrets.json"),
      path.join(root, ".jazz-stage-copy-id", "nested", "ordinary.txt"),
      path.join(root, ".jazz-previous-copy-id", "nested", "ordinary.txt"),
    ]) {
      expect(rules.reasonFor(secret)).toBeString();
    }
  });

  it("leaves everything else alone, including other programs' files", () => {
    const rules = loadSecretPathRules({ platform: "linux" });
    for (const ordinary of [
      path.join(jazzHome, "notes.md"),
      path.join(jazzHome, "history", "a.json"),
      path.join(jazzHome, "agents", "default.json"),
      path.join(os.homedir(), ".ssh", "id_ed25519"),
    ]) {
      expect(rules.reasonFor(ordinary)).toBeUndefined();
    }
  });

  it("follows JAZZ_CONFIG_PATH to wherever the config lives", () => {
    const elsewhere = path.join(root, "elsewhere.json");
    process.env["JAZZ_CONFIG_PATH"] = elsewhere;
    const rules = loadSecretPathRules({ platform: "linux" });
    expect(rules.reasonFor(elsewhere)).toBeString();
    expect(rules.reasonFor(path.join(root, ".elsewhere.json-123-abc.tmp"))).toBeString();
    expect(rules.reasonFor(`${elsewhere}.corrupt-2026-09-27`)).toBeString();
    expect(rules.reasonFor(path.join(jazzHome, "config.json"))).toBeUndefined();
  });

  it("compares case-insensitively on macOS", () => {
    const shouted = path.join(jazzHome, "SECRETS.JSON");
    expect(loadSecretPathRules({ platform: "darwin" }).reasonFor(shouted)).toBeString();
    expect(loadSecretPathRules({ platform: "linux" }).reasonFor(shouted)).toBeUndefined();
  });
});

describe("secretPathReason", () => {
  it("follows symlinks to a secret", () => {
    const rules = loadSecretPathRules({ platform: "linux" });
    const link = path.join(root, "innocent.txt");
    fs.symlinkSync(path.join(jazzHome, "secrets.json"), link);
    expect(rules.reasonFor(link)).toBeUndefined();
    expect(secretPathReason(link, rules)).toBeString();
  });

  it("matches a secret reached through a symlinked JAZZ_HOME", () => {
    const linkedHome = path.join(root, "linked-jazz");
    fs.symlinkSync(jazzHome, linkedHome);
    process.env["JAZZ_HOME"] = linkedHome;
    const rules = loadSecretPathRules({ platform: "linux" });
    expect(rules.reasonFor(path.join(jazzHome, "secrets.json"))).toBeString();
    expect(rules.reasonFor(path.join(linkedHome, "secrets.json"))).toBeString();
  });
});

describe("createSecretResultFilter", () => {
  it("drops results that are secret files, including through a symlinked search root", () => {
    const rules = loadSecretPathRules({ platform: "linux" });
    const linkedRoot = path.join(root, "home-link");
    fs.symlinkSync(jazzHome, linkedRoot);
    const isSecret = createSecretResultFilter(linkedRoot, rules);
    expect(isSecret(path.join(linkedRoot, "secrets.json"))).toBe(true);
    expect(isSecret("secrets.json")).toBe(true);
    expect(isSecret(path.join(linkedRoot, "notes.md"))).toBe(false);
  });
});
