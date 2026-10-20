/**
 * Checks the stdin-only macOS reader and writer and their native large-value round trip. Native operations
 * name a disposable keychain explicitly; cleanup deletes it even when an assertion fails.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { KeyringCommandRunner } from "./keyring";
import { readMacosKeychainItem, writeMacosKeychainItem } from "./macos-keychain";

describe("macOS keychain items", () => {
  it("carries values only on stdin and requires a successful native status", async () => {
    const item = { service: "jazz.test.vault", account: "secrets", value: "private-value" };
    for (const [ok, stdout, expected] of [
      [true, "0\n", true],
      [true, "-50\n", false],
      [true, "", false],
      [false, "0\n", false],
    ] as const) {
      const runner: KeyringCommandRunner = (command, args, stdin) => {
        expect(command).toBe("osascript");
        expect(args.join(" ")).not.toContain(item.value);
        expect(JSON.parse(stdin ?? "")).toEqual(item);
        return Effect.succeed({ ok, code: ok ? 0 : 1, stdout, stderr: "", unavailable: false });
      };
      expect(await Effect.runPromise(writeMacosKeychainItem(runner, item))).toBe(expected);
    }
  });

  it("reads a value only from a clean native hit", async () => {
    const item = { service: "jazz.test.vault", account: "secrets" };
    const value = "café 🎷";
    for (const [ok, stdout, expected] of [
      [true, `0:${Buffer.from(value).toString("base64")}\n`, { status: "ok", value }],
      [true, "-25300\n", { status: "absent" }],
      [true, "-25293\n", { status: "failed" }],
      [true, "", { status: "failed" }],
      [false, "-25300\n", { status: "failed" }],
    ] as const) {
      const runner: KeyringCommandRunner = (command, _args, stdin) => {
        expect(command).toBe("osascript");
        expect(JSON.parse(stdin ?? "")).toEqual(item);
        return Effect.succeed({ ok, code: ok ? 0 : 1, stdout, stderr: "", unavailable: false });
      };
      expect(await Effect.runPromise(readMacosKeychainItem(runner, item))).toEqual(expected);
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "creates, updates and reads back a large Unicode value",
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "jazz-native-vault-"));
      const keychainPath = path.join(directory, "test.keychain-db");
      const otherKeychainPath = path.join(directory, "other.keychain-db");
      const service = "jazz.native-test.vault";
      const account = "secrets";
      const security = (args: readonly string[]) =>
        spawnSync("/usr/bin/security", [...args], { encoding: "utf8", timeout: 5_000 });
      const runner: KeyringCommandRunner = (_command, args, stdin) =>
        Effect.sync(() => {
          const result = spawnSync("/usr/bin/osascript", [...args], {
            input: stdin,
            encoding: "utf8",
            timeout: 5_000,
          });
          return {
            ok: result.status === 0,
            code: result.status,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            unavailable: result.error !== undefined,
          };
        });
      try {
        expect(security(["create-keychain", "-p", "", keychainPath]).status).toBe(0);
        expect(security(["create-keychain", "-p", "", otherKeychainPath]).status).toBe(0);
        expect(
          security([
            "add-generic-password",
            "-s",
            service,
            "-a",
            account,
            "-w",
            "untouched",
            otherKeychainPath,
          ]).status,
        ).toBe(0);
        for (const value of ["token-".repeat(4_000), "updated café 🎷\n".repeat(2_000)]) {
          expect(
            await Effect.runPromise(
              writeMacosKeychainItem(runner, { service, account, value, keychainPath }),
            ),
          ).toBe(true);
          expect(
            await Effect.runPromise(
              readMacosKeychainItem(runner, { service, account, keychainPath }),
            ),
          ).toEqual({ status: "ok", value });
          const other = security([
            "find-generic-password",
            "-w",
            "-s",
            service,
            "-a",
            account,
            otherKeychainPath,
          ]);
          expect(other.status).toBe(0);
          expect(other.stdout).toBe("untouched\n");
        }
        expect(
          await Effect.runPromise(
            readMacosKeychainItem(runner, { service: `${service}.missing`, account, keychainPath }),
          ),
        ).toEqual({ status: "absent" });
      } finally {
        security(["delete-keychain", keychainPath]);
        security(["delete-keychain", otherKeychainPath]);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
