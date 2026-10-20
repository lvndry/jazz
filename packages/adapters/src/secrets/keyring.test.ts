/**
 * Tests home-scoped credential storage and legacy adoption with injected runners and fake keyring
 * executables. Temporary homes and controlled locks exercise failures, retries, and concurrent
 * migration without touching the real OS keyring.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { Effect } from "effect";
import {
  type CommandResult,
  type KeyringCommandRunner,
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringServiceName,
  keyringSet,
  keyringVaultServiceName,
  migrateKeyringEntriesIntoVault,
  type VaultLock,
} from "./keyring";

const originalDisable = process.env["JAZZ_DISABLE_KEYRING"];

afterEach(() => {
  if (originalDisable === undefined) {
    delete process.env["JAZZ_DISABLE_KEYRING"];
  } else {
    process.env["JAZZ_DISABLE_KEYRING"] = originalDisable;
  }
});

describe("keyring opt-out", () => {
  it("reports no backend when JAZZ_DISABLE_KEYRING is set", async () => {
    process.env["JAZZ_DISABLE_KEYRING"] = "1";
    expect(await Effect.runPromise(detectKeyringBackend())).toBe("none");
  });

  it("treats explicit falsy values as not opting out", async () => {
    for (const value of ["0", "false", "", "  "]) {
      process.env["JAZZ_DISABLE_KEYRING"] = value;
      // Platform decides the result, but it must not short-circuit to "none"
      // for the opt-out reason on a platform Jazz supports.
      const backend = await Effect.runPromise(detectKeyringBackend());
      if (process.platform === "darwin") {
        expect(backend).toBe("macos");
      } else {
        // No real OS keyring on this runner falls through to the file store, not "none" —
        // "none" is now reachable only via the opt-out env var above.
        expect(["libsecret", "file"]).toContain(backend);
      }
    }
  });
});

describe('the "none" backend', () => {
  it("reads nothing, refuses writes, and ignores deletes", async () => {
    expect(await Effect.runPromise(keyringGet("none", "llm.openai.api_key"))).toBeUndefined();
    expect(await Effect.runPromise(keyringSet("none", "llm.openai.api_key", "sk-x"))).toBe(false);
    await Effect.runPromise(keyringDelete("none", "llm.openai.api_key"));
  });
});

describe('the "file" backend — the headless-server fallback below both OS keyrings', () => {
  const originalJazzHome = process.env["JAZZ_HOME"];
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-keyring-file-test-"));
    process.env["JAZZ_HOME"] = tempDirectory;
  });

  afterEach(() => {
    if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = originalJazzHome;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("round-trips a secret through a chmod-600 file under $JAZZ_HOME", async () => {
    expect(await Effect.runPromise(keyringGet("file", "peers.bob.token"))).toBeUndefined();

    const stored = await Effect.runPromise(keyringSet("file", "peers.bob.token", "s3cret"));
    expect(stored).toBe(true);

    const secretsPath = path.join(tempDirectory, "secrets.json");
    expect(fs.existsSync(secretsPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
    }

    expect(await Effect.runPromise(keyringGet("file", "peers.bob.token"))).toBe("s3cret");
  });

  it("keeps other accounts intact when storing or deleting one", async () => {
    await Effect.runPromise(keyringSet("file", "peers.bob.token", "bob-secret"));
    await Effect.runPromise(keyringSet("file", "peers.alice.token", "alice-secret"));

    await Effect.runPromise(keyringDelete("file", "peers.bob.token"));

    expect(await Effect.runPromise(keyringGet("file", "peers.bob.token"))).toBeUndefined();
    expect(await Effect.runPromise(keyringGet("file", "peers.alice.token"))).toBe("alice-secret");
  });

  it("serializes concurrent file-backend updates", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Effect.runPromise(keyringSet("file", `plugin/test/key-${index}`, `value-${index}`)),
      ),
    );
    for (let index = 0; index < 20; index++) {
      expect(await Effect.runPromise(keyringGet("file", `plugin/test/key-${index}`))).toBe(
        `value-${index}`,
      );
    }
  });

  it("deleting an absent account is a no-op, not an error", async () => {
    await Effect.runPromise(keyringDelete("file", "peers.nobody.token"));
    expect(await Effect.runPromise(keyringGet("file", "peers.nobody.token"))).toBeUndefined();
  });

  it("treats a corrupt secrets.json as empty rather than failing every lookup", async () => {
    fs.mkdirSync(tempDirectory, { recursive: true });
    fs.writeFileSync(path.join(tempDirectory, "secrets.json"), "{not valid json");

    expect(await Effect.runPromise(keyringGet("file", "peers.bob.token"))).toBeUndefined();
    expect(await Effect.runPromise(keyringSet("file", "peers.bob.token", "s3cret"))).toBe(true);
    expect(await Effect.runPromise(keyringGet("file", "peers.bob.token"))).toBe("s3cret");
  });
});

describe("keyringServiceName", () => {
  it("gives each resolved home its own service and one home a stable one", () => {
    const first = keyringServiceName("/home/sam/.jazz");
    expect(first).toMatch(/^jazz\.[0-9a-f]{16}$/);
    expect(keyringServiceName("/home/sam/.jazz/")).toBe(first);
    expect(keyringServiceName("/home/sam/other-home")).not.toBe(first);
  });
});

describe("keyringVaultServiceName", () => {
  it("names a service of its own beside the home's per-entry service", () => {
    expect(keyringVaultServiceName("/home/sam/.jazz")).toBe(
      `${keyringServiceName("/home/sam/.jazz")}.vault`,
    );
  });
});

const VAULT_SERVICE = "jazz.abc.vault";
const VAULT_KEY = `${VAULT_SERVICE}\u0000secrets`;

const withoutLock: VaultLock = (operation) => operation();

function encodeVault(secrets: Record<string, string>): string {
  return Buffer.from(JSON.stringify(secrets)).toString("base64");
}

function vaultIn(entries: Map<string, string>): Record<string, string> | undefined {
  const raw = entries.get(VAULT_KEY);
  return raw === undefined ? undefined : JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

/** An in-memory keychain answering the `security` CLI the way macOS does, keyed by service and account. */
function fakeMacosKeychain(entries: Map<string, string>): KeyringCommandRunner {
  const key = (service: string, account: string): string => `${service}\u0000${account}`;
  const flag = (args: readonly string[], name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const result = (ok: boolean, stdout = ""): CommandResult => ({
    ok,
    code: ok ? 0 : 44,
    stdout,
    stderr: "",
    unavailable: false,
  });
  const answer = (args: readonly string[]): CommandResult => {
    const service = flag(args, "-s") ?? "";
    const account = flag(args, "-a");
    switch (args[0]) {
      case "find-generic-password": {
        if (account === undefined) {
          const match = [...entries.keys()].find((entry) => entry.startsWith(`${service}\u0000`));
          if (match === undefined) {
            return result(false);
          }
          const matchedAccount = match.slice(service.length + 1);
          return result(true, `attributes:\n    "acct"<blob>="${matchedAccount}"\n`);
        }
        const value = entries.get(key(service, account));
        return value === undefined ? result(false) : result(true, `${value}\n`);
      }
      case "add-generic-password": {
        const hex = flag(args, "-X");
        const value = hex === undefined ? flag(args, "-w") : Buffer.from(hex, "hex").toString();
        entries.set(key(service, account ?? ""), value ?? "");
        return result(true);
      }
      case "delete-generic-password":
        return result(entries.delete(key(service, account ?? "")));
      default:
        return result(false);
    }
  };
  return (command, args, stdin) =>
    Effect.sync(() => {
      if (command === "osascript") {
        const item = JSON.parse(stdin ?? "") as {
          service: string;
          account: string;
          value?: string;
        };
        if (item.value === undefined) {
          const value = entries.get(key(item.service, item.account));
          return value === undefined
            ? result(true, "-25300\n")
            : result(true, `0:${Buffer.from(value).toString("base64")}\n`);
        }
        entries.set(key(item.service, item.account), item.value);
        return result(true, "0\n");
      }
      return args[0] === "-i" ? answer((stdin ?? "").trim().split(" ")) : answer(args);
    });
}

describe("migrateKeyringEntriesIntoVault", () => {
  it("migrates a large credential without exceeding security's interactive line limit", async () => {
    const credential = "token-".repeat(4_000);
    const entries = new Map([["jazz\u0000chatgpt.oauth.credential", credential]]);
    const keychain = fakeMacosKeychain(entries);
    const boundedSecurity: KeyringCommandRunner = (command, args, stdin) =>
      args[0] === "-i" && Buffer.byteLength(stdin ?? "") > 4_095
        ? Effect.succeed({ ok: false, code: 1, stdout: "", stderr: "", unavailable: false })
        : keychain(command, args, stdin);

    const migration = await Effect.runPromise(
      migrateKeyringEntriesIntoVault("macos", "jazz", VAULT_SERVICE, boundedSecurity, withoutLock),
    );

    expect(migration.complete).toBe(true);
    expect(vaultIn(entries)).toEqual({ "chatgpt.oauth.credential": credential });
    expect(entries.has("jazz\u0000chatgpt.oauth.credential")).toBe(false);
  });

  it("moves every item into the vault and deletes the originals", async () => {
    const entries = new Map([
      ["jazz\u0000llm.openai.api_key", "sk-legacy"],
      ["jazz\u0000peers.sam.token", "peer-token"],
      ["other-app\u0000llm.openai.api_key", "not jazz"],
    ]);
    const moved = await Effect.runPromise(
      migrateKeyringEntriesIntoVault(
        "macos",
        "jazz",
        VAULT_SERVICE,
        fakeMacosKeychain(entries),
        withoutLock,
      ),
    );

    expect([...moved.moved].sort()).toEqual(["llm.openai.api_key", "peers.sam.token"]);
    expect(moved.complete).toBe(true);
    expect(vaultIn(entries)).toEqual({
      "llm.openai.api_key": "sk-legacy",
      "peers.sam.token": "peer-token",
    });
    expect([...entries.keys()].some((entry) => entry.startsWith("jazz\u0000"))).toBe(false);
    expect(entries.get("other-app\u0000llm.openai.api_key")).toBe("not jazz");
  });

  it("keeps a value the vault already has and still retires the item", async () => {
    const entries = new Map([
      ["jazz\u0000llm.openai.api_key", "sk-legacy"],
      [VAULT_KEY, encodeVault({ "llm.openai.api_key": "sk-current" })],
    ]);
    await Effect.runPromise(
      migrateKeyringEntriesIntoVault(
        "macos",
        "jazz",
        VAULT_SERVICE,
        fakeMacosKeychain(entries),
        withoutLock,
      ),
    );

    expect(vaultIn(entries)).toEqual({ "llm.openai.api_key": "sk-current" });
    expect(entries.has("jazz\u0000llm.openai.api_key")).toBe(false);
  });

  it("stops without deleting when the vault cannot be written", async () => {
    const entries = new Map([["jazz\u0000llm.openai.api_key", "sk-legacy"]]);
    const keychain = fakeMacosKeychain(entries);
    const refusingWrites: KeyringCommandRunner = (command, args, stdin) =>
      command === "osascript"
        ? Effect.succeed({ ok: false, code: 1, stdout: "", stderr: "denied", unavailable: false })
        : keychain(command, args, stdin);

    const moved = await Effect.runPromise(
      migrateKeyringEntriesIntoVault("macos", "jazz", VAULT_SERVICE, refusingWrites, withoutLock),
    );

    expect(moved).toEqual({ moved: [], complete: false });
    expect(entries.get("jazz\u0000llm.openai.api_key")).toBe("sk-legacy");
  });

  it("leaves a vault it cannot read untouched rather than overwrite what it holds", async () => {
    const entries = new Map([["jazz\u0000llm.openai.api_key", "sk-legacy"]]);
    const keychain = fakeMacosKeychain(entries);
    const lockedVault: KeyringCommandRunner = (command, args, stdin) =>
      command === "osascript" && stdin?.includes(VAULT_SERVICE)
        ? Effect.succeed({ ok: false, code: 51, stdout: "", stderr: "", unavailable: false })
        : keychain(command, args, stdin);

    const moved = await Effect.runPromise(
      migrateKeyringEntriesIntoVault("macos", "jazz", VAULT_SERVICE, lockedVault, withoutLock),
    );

    expect(moved).toEqual({ moved: [], complete: false });
    expect(entries.get("jazz\u0000llm.openai.api_key")).toBe("sk-legacy");
    expect(entries.has(VAULT_KEY)).toBe(false);
  });

  it("leaves a vault in an unknown encoding untouched", async () => {
    const entries = new Map([
      ["jazz\u0000llm.openai.api_key", "sk-legacy"],
      [VAULT_KEY, "not base64 json"],
    ]);

    const moved = await Effect.runPromise(
      migrateKeyringEntriesIntoVault(
        "macos",
        "jazz",
        VAULT_SERVICE,
        fakeMacosKeychain(entries),
        withoutLock,
      ),
    );

    expect(moved).toEqual({ moved: [], complete: false });
    expect(entries.get(VAULT_KEY)).toBe("not base64 json");
  });

  it("migrates through secret-tool on Linux", async () => {
    const entries = new Map([["jazz\u0000llm.openai.api_key", "sk-legacy"]]);
    const attribute = (args: readonly string[], name: string): string =>
      args[args.indexOf(name) + 1] ?? "";
    const secretTool: KeyringCommandRunner = (_command, args, stdin) =>
      Effect.sync(() => {
        const service = attribute(args, "service");
        const ok = (stdout = ""): CommandResult => ({
          ok: true,
          code: 0,
          stdout,
          stderr: "",
          unavailable: false,
        });
        const missing: CommandResult = {
          ok: false,
          code: 1,
          stdout: "",
          stderr: "",
          unavailable: false,
        };
        switch (args[0]) {
          case "search": {
            const match = [...entries.keys()].find((entry) => entry.startsWith(`${service}\u0000`));
            if (match === undefined) {
              return ok();
            }
            return ok(
              `[/1]\nlabel = jazz\nsecret = x\nattribute.service = ${service}\nattribute.account = ${match.slice(service.length + 1)}\n`,
            );
          }
          case "lookup": {
            const value = entries.get(`${service}\u0000${attribute(args, "account")}`);
            return value === undefined ? missing : ok(value);
          }
          case "store":
            entries.set(`${service}\u0000${attribute(args, "account")}`, stdin ?? "");
            return ok();
          case "clear":
            entries.delete(`${service}\u0000${attribute(args, "account")}`);
            return ok();
          default:
            return missing;
        }
      });

    expect(
      await Effect.runPromise(
        migrateKeyringEntriesIntoVault("libsecret", "jazz", VAULT_SERVICE, secretTool, withoutLock),
      ),
    ).toEqual({ moved: ["llm.openai.api_key"], complete: true });
    expect([...entries.keys()]).toEqual([VAULT_KEY]);
    expect(vaultIn(entries)).toEqual({ "llm.openai.api_key": "sk-legacy" });
  });

  it("does not restore a secret another process migrates and deletes before this pass gets the lock", async () => {
    const sourceKey = "jazz\0retained";
    const entries = new Map([[sourceKey, "legacy-value"]]);
    const keychain = fakeMacosKeychain(entries);
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const pausedLock: VaultLock = async (operation) => {
      entered.resolve();
      await resumed.promise;
      return operation();
    };
    const pending = Effect.runPromise(
      migrateKeyringEntriesIntoVault("macos", "jazz", VAULT_SERVICE, keychain, pausedLock),
    );
    await entered.promise;
    await Effect.runPromise(
      migrateKeyringEntriesIntoVault("macos", "jazz", VAULT_SERVICE, keychain, withoutLock),
    );
    expect(vaultIn(entries)).toEqual({ retained: "legacy-value" });
    expect(entries.has(sourceKey)).toBe(false);
    entries.set(VAULT_KEY, encodeVault({}));
    resumed.resolve();
    await pending;
    expect(vaultIn(entries)).toEqual({});
  });

  for (const backend of ["macos", "libsecret"] as const) {
    it(`does not treat a failed ${backend} discovery as completed migration`, async () => {
      const failed: KeyringCommandRunner = () =>
        Effect.succeed({
          ok: false,
          code: backend === "macos" ? 51 : 1,
          stdout: "",
          stderr: "",
          unavailable: false,
        });
      expect(
        await Effect.runPromise(
          migrateKeyringEntriesIntoVault(backend, "jazz", VAULT_SERVICE, failed, withoutLock),
        ),
      ).toEqual({ moved: [], complete: false });
    });
  }

  it("reads a hex-encoded account name", async () => {
    const account = "plugin/com.example/tök";
    const entries = new Map([[`jazz\u0000${account}`, "value"]]);
    const keychain = fakeMacosKeychain(entries);
    const hexAttributes: KeyringCommandRunner = (command, args, stdin) =>
      args[0] === "find-generic-password" &&
      !args.includes("-a") &&
      entries.has(`jazz\u0000${account}`)
        ? Effect.succeed({
            ok: true,
            code: 0,
            stdout: `    "acct"<blob>=0x${Buffer.from(account).toString("hex").toUpperCase()}  "plugin/com.example/t\\303\\266k"\n`,
            stderr: "",
            unavailable: false,
          })
        : keychain(command, args, stdin);

    expect(
      await Effect.runPromise(
        migrateKeyringEntriesIntoVault("macos", "jazz", VAULT_SERVICE, hexAttributes, withoutLock),
      ),
    ).toEqual({ moved: [account], complete: true });
    expect(vaultIn(entries)).toEqual({ [account]: "value" });
  });
});

/** Exercises the public lookup cache through a disposable `security` executable, never the OS keychain. */
describe("retrying legacy vault adoption", () => {
  const originalJazzHome = process.env["JAZZ_HOME"];
  const originalPath = process.env["PATH"];
  let directory: string;
  let entriesFile: string;
  let failureFile: string;
  let callsFile: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-keyring-retry-"));
    process.env["JAZZ_HOME"] = directory;
    process.env["PATH"] = `${directory}${path.delimiter}${originalPath ?? ""}`;
    entriesFile = path.join(directory, "entries.json");
    failureFile = path.join(directory, "failure.json");
    callsFile = path.join(directory, "calls.jsonl");
    fs.writeFileSync(entriesFile, "{}");
    fs.writeFileSync(callsFile, "");
    const executable = String.raw`#!${process.execPath}
const fs = require("node:fs");
const entriesFile = ${JSON.stringify(entriesFile)};
const failureFile = ${JSON.stringify(failureFile)};
const callsFile = ${JSON.stringify(callsFile)};
let args = process.argv.slice(2);
const viaOsascript = process.argv[1].endsWith("osascript");
if (viaOsascript) {
  const item = JSON.parse(fs.readFileSync(0, "utf8"));
  args = item.value === undefined
    ? ["find-generic-password", "-s", item.service, "-a", item.account]
    : ["add-generic-password", "-s", item.service, "-a", item.account, "-w", item.value];
}
const flag = (name) => args[args.indexOf(name) + 1];
const service = flag("-s");
const account = args.includes("-a") ? flag("-a") : undefined;
const key = service + "\0" + account;
const operation = args[0] === "add-generic-password" ? "write"
  : args[0] === "delete-generic-password" ? "delete"
  : account === undefined ? "discover"
  : service.endsWith(".vault") ? "vault-read" : "legacy-read";
fs.appendFileSync(callsFile, JSON.stringify({ operation, service, account }) + "\n");
if (fs.existsSync(failureFile)) {
  const failure = JSON.parse(fs.readFileSync(failureFile, "utf8"));
  if (failure.operation === operation) {
    if (failure.skip === 0) {
      fs.unlinkSync(failureFile);
      process.exit(51);
    }
    fs.writeFileSync(failureFile, JSON.stringify({ ...failure, skip: failure.skip - 1 }));
  }
}
const entries = JSON.parse(fs.readFileSync(entriesFile, "utf8"));
if (args[0] === "find-generic-password") {
  if (viaOsascript) {
    process.stdout.write(key in entries
      ? "0:" + Buffer.from(entries[key]).toString("base64") + "\n"
      : "-25300\n");
  } else if (account !== undefined) {
    if (!(key in entries)) process.exit(44);
    process.stdout.write(entries[key] + "\n");
  } else {
    const match = Object.keys(entries).find((entry) => entry.startsWith(service + "\0"));
    if (match === undefined) process.exit(44);
    process.stdout.write('    "acct"<blob>="' + match.slice(service.length + 1) + '"\n');
  }
} else if (args[0] === "add-generic-password") {
  entries[key] = flag("-w");
  process.stdout.write("0\n");
  fs.writeFileSync(entriesFile, JSON.stringify(entries));
} else if (args[0] === "delete-generic-password") {
  if (!(key in entries)) process.exit(44);
  delete entries[key];
  fs.writeFileSync(entriesFile, JSON.stringify(entries));
} else process.exit(2);
`;
    fs.writeFileSync(path.join(directory, "security"), executable, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "osascript"), executable, { mode: 0o700 });
  });

  afterEach(() => {
    setSystemTime();
    if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = originalJazzHome;
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function entries(): Record<string, string> {
    return JSON.parse(fs.readFileSync(entriesFile, "utf8")) as Record<string, string>;
  }

  function discoveryCount(): number {
    return fs
      .readFileSync(callsFile, "utf8")
      .split("\n")
      .filter((line) => line.includes('"operation":"discover"')).length;
  }

  function expireSnapshot(): void {
    setSystemTime(new Date(Date.now() + 2_001));
  }

  for (const operation of ["legacy-read", "write", "discover", "vault-read"]) {
    it(`retries after a transient ${operation} failure and shares a completed adoption`, async () => {
      const sourceKey = `${keyringServiceName()}\0llm.openai.api_key`;
      fs.writeFileSync(entriesFile, JSON.stringify({ [sourceKey]: "legacy-value" }));
      fs.writeFileSync(
        failureFile,
        JSON.stringify({ operation, skip: operation === "vault-read" ? 1 : 0 }),
      );

      expect(await Effect.runPromise(keyringGet("macos", "llm.openai.api_key"))).toBeUndefined();
      expect(entries()[sourceKey]).toBe("legacy-value");
      expireSnapshot();
      expect(
        await Promise.all(
          Array.from({ length: 4 }, () =>
            Effect.runPromise(keyringGet("macos", "llm.openai.api_key")),
          ),
        ),
      ).toEqual(Array.from({ length: 4 }, () => "legacy-value"));
      expect(entries()[sourceKey]).toBeUndefined();
      const afterAdoption = discoveryCount();
      expect(afterAdoption).toBe(3);
      expireSnapshot();
      expect(await Effect.runPromise(keyringGet("macos", "llm.openai.api_key"))).toBe(
        "legacy-value",
      );
      expect(discoveryCount()).toBe(afterAdoption);
    });
  }

  it("keeps partial progress and existing vault values when the next write fails", async () => {
    const source = keyringServiceName();
    const vaultKey = `${keyringVaultServiceName()}\0secrets`;
    fs.writeFileSync(
      entriesFile,
      JSON.stringify({
        [`${source}\0first`]: "first-value",
        [`${source}\0second`]: "second-value",
        [vaultKey]: encodeVault({ existing: "current-value" }),
      }),
    );
    fs.writeFileSync(failureFile, JSON.stringify({ operation: "write", skip: 1 }));
    expect(await Effect.runPromise(keyringGet("macos", "second"))).toBeUndefined();
    expect(entries()[`${source}\0first`]).toBeUndefined();
    expect(entries()[`${source}\0second`]).toBe("second-value");
    expireSnapshot();
    expect(await Effect.runPromise(keyringGet("macos", "second"))).toBe("second-value");
    expect(JSON.parse(Buffer.from(entries()[vaultKey] ?? "", "base64").toString("utf8"))).toEqual({
      existing: "current-value",
      first: "first-value",
      second: "second-value",
    });
  });
  it("does not delete a vault secret until its remaining legacy source can be retired", async () => {
    const sourceKey = `${keyringServiceName()}\0retained`;
    const vaultKey = `${keyringVaultServiceName()}\0secrets`;
    fs.writeFileSync(
      entriesFile,
      JSON.stringify({
        [sourceKey]: "legacy-value",
        [vaultKey]: encodeVault({ retained: "current-value" }),
      }),
    );
    fs.writeFileSync(failureFile, JSON.stringify({ operation: "delete", skip: 0 }));
    await Effect.runPromise(keyringDelete("macos", "retained"));
    expect(entries()[sourceKey]).toBe("legacy-value");
    expect(JSON.parse(Buffer.from(entries()[vaultKey] ?? "", "base64").toString("utf8"))).toEqual({
      retained: "current-value",
    });
    await Effect.runPromise(keyringDelete("macos", "retained"));
    expect(entries()[sourceKey]).toBeUndefined();
    expireSnapshot();
    expect(await Effect.runPromise(keyringGet("macos", "retained"))).toBeUndefined();
  });
});
