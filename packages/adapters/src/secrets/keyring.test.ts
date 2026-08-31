import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { detectKeyringBackend, keyringGet, keyringSet, keyringDelete } from "./keyring";

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
