import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  type CommandResult,
  type KeyringCommandRunner,
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringServiceName,
  keyringSet,
  migrateLegacyKeyringEntries,
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
  return (_command, args) =>
    Effect.sync(() => {
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
        case "add-generic-password":
          entries.set(key(service, account ?? ""), flag(args, "-w") ?? "");
          return result(true);
        case "delete-generic-password":
          return result(entries.delete(key(service, account ?? "")));
        default:
          return result(false);
      }
    });
}

describe("migrateLegacyKeyringEntries", () => {
  it("moves every legacy entry into the home's service and deletes the originals", async () => {
    const entries = new Map([
      ["jazz\u0000llm.openai.api_key", "sk-legacy"],
      ["jazz\u0000peers.sam.token", "peer-token"],
      ["other-app\u0000llm.openai.api_key", "not jazz"],
    ]);
    const moved = await Effect.runPromise(
      migrateLegacyKeyringEntries("macos", "jazz.abc", fakeMacosKeychain(entries)),
    );

    expect([...moved].sort()).toEqual(["llm.openai.api_key", "peers.sam.token"]);
    expect(entries.get("jazz.abc\u0000llm.openai.api_key")).toBe("sk-legacy");
    expect(entries.get("jazz.abc\u0000peers.sam.token")).toBe("peer-token");
    expect([...entries.keys()].some((entry) => entry.startsWith("jazz\u0000"))).toBe(false);
    expect(entries.get("other-app\u0000llm.openai.api_key")).toBe("not jazz");
  });

  it("keeps a value the home already has and still retires the legacy copy", async () => {
    const entries = new Map([
      ["jazz\u0000llm.openai.api_key", "sk-legacy"],
      ["jazz.abc\u0000llm.openai.api_key", "sk-current"],
    ]);
    await Effect.runPromise(
      migrateLegacyKeyringEntries("macos", "jazz.abc", fakeMacosKeychain(entries)),
    );

    expect(entries.get("jazz.abc\u0000llm.openai.api_key")).toBe("sk-current");
    expect(entries.has("jazz\u0000llm.openai.api_key")).toBe(false);
  });

  it("stops without deleting when the scoped copy cannot be stored", async () => {
    const entries = new Map([["jazz\u0000llm.openai.api_key", "sk-legacy"]]);
    const keychain = fakeMacosKeychain(entries);
    const refusingWrites: KeyringCommandRunner = (command, args, stdin) =>
      args[0] === "add-generic-password"
        ? Effect.succeed({ ok: false, code: 1, stdout: "", stderr: "denied", unavailable: false })
        : keychain(command, args, stdin);

    const moved = await Effect.runPromise(
      migrateLegacyKeyringEntries("macos", "jazz.abc", refusingWrites),
    );

    expect(moved).toEqual([]);
    expect(entries.get("jazz\u0000llm.openai.api_key")).toBe("sk-legacy");
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
              return missing;
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
      await Effect.runPromise(migrateLegacyKeyringEntries("libsecret", "jazz.abc", secretTool)),
    ).toEqual(["llm.openai.api_key"]);
    expect([...entries]).toEqual([["jazz.abc\u0000llm.openai.api_key", "sk-legacy"]]);
  });

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
      await Effect.runPromise(migrateLegacyKeyringEntries("macos", "jazz.abc", hexAttributes)),
    ).toEqual([account]);
    expect(entries.get(`jazz.abc\u0000${account}`)).toBe("value");
  });
});
