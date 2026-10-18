/**
 * Checks the stdin-only macOS writer and its native large-value round trip. Native operations
 * name a disposable keychain explicitly; cleanup deletes it even when an assertion fails.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { KeyringCommandRunner } from "./keyring";
import { writeMacosKeychainItem } from "./macos-keychain-write";

describe("macOS keychain writer", () => {
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

  it.skipIf(process.platform !== "darwin")(
    "creates and updates a large Unicode value that security can read without a prompt",
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
          const read = security([
            "find-generic-password",
            "-w",
            "-s",
            service,
            "-a",
            account,
            keychainPath,
          ]);
          expect(read.status).toBe(0);
          const text = read.stdout.replace(/\n$/, "");
          const decoded = /^[0-9a-f]+$/i.test(text)
            ? Buffer.from(text, "hex").toString("utf8")
            : text;
          expect(decoded).toBe(value);
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
        const access = security(["dump-keychain", "-a", keychainPath]);
        expect(access.status).toBe(0);
        expect(access.stdout).toContain("/usr/bin/security");
        expect(access.stdout).toContain("/usr/bin/osascript");
        const legacyService = `${service}.legacy`;
        expect(
          security([
            "add-generic-password",
            "-s",
            legacyService,
            "-a",
            account,
            "-w",
            "old",
            keychainPath,
          ]).status,
        ).toBe(0);
        expect(
          await Effect.runPromise(
            writeMacosKeychainItem(runner, {
              service: legacyService,
              account,
              value: "new".repeat(8_000),
              keychainPath,
            }),
          ),
        ).toBe(true);
        const updated = security([
          "find-generic-password",
          "-w",
          "-s",
          legacyService,
          "-a",
          account,
          keychainPath,
        ]);
        expect(updated.status).toBe(0);
        expect(updated.stdout).toBe(`${"new".repeat(8_000)}\n`);
      } finally {
        security(["delete-keychain", keychainPath]);
        security(["delete-keychain", otherKeychainPath]);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
