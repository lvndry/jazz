/**
 * Checks the stdin-only `osascript` reader and its native round trip against an item written the
 * way 0.16.19 and 0.16.20 wrote vaults. Native operations name a disposable keychain explicitly;
 * cleanup deletes it even when an assertion fails.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { KeyringCommandRunner } from "./keyring";
import { readMacosKeychainItem } from "./macos-keychain";

/** How 0.16.19 and 0.16.20 wrote a vault: Security.framework through `osascript`, value on stdin. */
const OSASCRIPT_VAULT_WRITE_SCRIPT = `
ObjC.import('Security');
ObjC.import('Foundation');
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, 4)));
  var opened = Ref();
  var status = $.SecKeychainOpen(payload.keychainPath, opened);
  if (status !== 0) return String(status);
  var item = {class: 'genp', svce: payload.service, acct: payload.account,
              v_Data: $(payload.value).dataUsingEncoding(4),
              u_Keychain: ObjC.castRefToObject(opened[0])};
  return String($.SecItemAdd($(item), null));
}
`;

describe("macOS osascript keychain reader", () => {
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
    "reads back a large Unicode value osascript wrote, only from the keychain named",
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "jazz-native-vault-"));
      const keychainPath = path.join(directory, "test.keychain-db");
      const otherKeychainPath = path.join(directory, "other.keychain-db");
      const service = "jazz.native-test.vault";
      const account = "secrets";
      const value = "updated café 🎷\n".repeat(2_000);
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
        const written = spawnSync(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", OSASCRIPT_VAULT_WRITE_SCRIPT],
          {
            input: JSON.stringify({ service, account, value, keychainPath }),
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(written.stdout.trim()).toBe("0");
        expect(
          await Effect.runPromise(
            readMacosKeychainItem(runner, { service, account, keychainPath }),
          ),
        ).toEqual({ status: "ok", value });
        expect(
          await Effect.runPromise(
            readMacosKeychainItem(runner, { service, account, keychainPath: otherKeychainPath }),
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
