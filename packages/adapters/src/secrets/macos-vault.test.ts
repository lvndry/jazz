/**
 * Checks the chunked macOS vault against an in-memory keychain that enforces the `security -i` line
 * limit: chunking, slot alternation, retiring replaced chunks, and keeping the previous vault in
 * force when a write fails partway.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { KeyringCommandRunner } from "./keyring";
import {
  fakeMacosKeychain,
  keychainKey,
  SECURITY_INTERACTIVE_LINE_LIMIT,
} from "./macos-keychain.fixture";
import {
  assembleMacosVault,
  MACOS_VAULT_CHUNK_LENGTH,
  MACOS_VAULT_MAX_CHUNKS,
  macosVaultWriteScript,
  readMacosVault,
  writeMacosVault,
} from "./macos-vault";

const SERVICE = "jazz.0123456789abcdef.vault";

async function store(run: KeyringCommandRunner, encoded: string): Promise<boolean> {
  const read = await Effect.runPromise(readMacosVault(run, SERVICE));
  if (read.status === "failed") {
    throw new Error("vault read failed");
  }
  return Effect.runPromise(writeMacosVault(run, SERVICE, encoded, read.layout));
}

async function stored(run: KeyringCommandRunner): Promise<string | undefined> {
  const read = await Effect.runPromise(readMacosVault(run, SERVICE));
  return read.status === "ok" ? read.encoded : undefined;
}

describe("chunked macOS vault", () => {
  it("round-trips a vault spanning many chunks with every command line under the limit", async () => {
    const entries = new Map<string, string>();
    const run = fakeMacosKeychain(entries);
    const encoded = "QUJD".repeat(Math.floor((MACOS_VAULT_CHUNK_LENGTH * 7.5) / 4));
    expect(await store(run, encoded)).toBe(true);
    expect(await stored(run)).toBe(encoded);
    const write = macosVaultWriteScript(SERVICE, encoded, { accounts: [] });
    for (const line of write?.script.split("\n") ?? []) {
      expect(Buffer.byteLength(line)).toBeLessThan(SECURITY_INTERACTIVE_LINE_LIMIT);
    }
  });

  it("alternates slots and retires the chunks a new generation replaces", async () => {
    const entries = new Map<string, string>();
    const run = fakeMacosKeychain(entries);
    expect(await store(run, "A".repeat(MACOS_VAULT_CHUNK_LENGTH * 3))).toBe(true);
    expect(await store(run, "QkI=")).toBe(true);
    expect([...entries.keys()]).toEqual([keychainKey(SERVICE, "vault.b.0")]);
    expect(await store(run, "Q0M=")).toBe(true);
    expect([...entries.keys()]).toEqual([keychainKey(SERVICE, "vault.a.0")]);
    expect(await stored(run)).toBe("Q0M=");
  });

  it("keeps the previous vault when a write fails partway, and clears the debris next time", async () => {
    const entries = new Map<string, string>();
    const keychain = fakeMacosKeychain(entries);
    expect(await store(keychain, "T0xE")).toBe(true);
    const failingThirdChunk: KeyringCommandRunner = (command, args, stdin) =>
      stdin?.startsWith("add-generic-password")
        ? keychain(command, args, stdin.split("\n").slice(0, 2).join("\n")).pipe(
            Effect.map((result) => ({
              ...result,
              stderr: `${result.stderr}add-generic-password: returned -25308\n`,
            })),
          )
        : keychain(command, args, stdin);
    expect(await store(failingThirdChunk, "TkVX".repeat(MACOS_VAULT_CHUNK_LENGTH))).toBe(false);
    expect(await stored(keychain)).toBe("T0xE");
    expect(await store(keychain, "TkVX")).toBe(true);
    expect(await stored(keychain)).toBe("TkVX");
    expect(entries.size).toBe(1);
  });

  it("refuses a vault larger than its chunks can hold, leaving the current one", async () => {
    const entries = new Map<string, string>();
    const run = fakeMacosKeychain(entries);
    expect(await store(run, "T0xE")).toBe(true);
    const oversized = "A".repeat(MACOS_VAULT_CHUNK_LENGTH * MACOS_VAULT_MAX_CHUNKS + 1);
    expect(await store(run, oversized)).toBe(false);
    expect(await stored(run)).toBe("T0xE");
  });

  it("reports a read the keychain refused as failed, not absent", async () => {
    const refused: KeyringCommandRunner = () =>
      Effect.succeed({
        ok: true,
        code: 0,
        stdout: "",
        stderr: "find-generic-password: returned -25300\nfind-generic-password: returned -128\n",
        unavailable: false,
      });
    expect(await Effect.runPromise(readMacosVault(refused, SERVICE))).toEqual({ status: "failed" });
  });

  it("takes the newest complete generation and ignores an incomplete newer one", () => {
    expect(
      assembleMacosVault(["a.4.0.1.T0xE", "b.5.0.2.TkVX", "not a chunk", "a.3.0.1.T0xEUg=="]),
    ).toEqual({
      current: { slot: "a", generation: 4 },
      accounts: ["vault.a.0", "vault.b.0", "vault.a.0"],
      encoded: "T0xE",
    });
    expect(assembleMacosVault(["b.5.0.2.TkVX"])).toEqual({ accounts: ["vault.b.0"] });
  });
});
