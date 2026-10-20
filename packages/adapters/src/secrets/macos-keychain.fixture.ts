/**
 * An in-memory macOS keychain for tests, answering `security` (including multi-command `security -i`
 * sessions and their 4,095-byte line limit) and the `osascript` reader the way macOS does. Entries
 * are keyed `<service>\0<account>`.
 */
import { Effect } from "effect";
import type { CommandResult, KeyringCommandRunner } from "./keyring";
import { assembleMacosVault } from "./macos-vault";

/** `security -i` rejects longer command lines. */
export const SECURITY_INTERACTIVE_LINE_LIMIT = 4_095;

const NOT_FOUND_EXIT_CODE = 44;
const NOT_FOUND_STATUS = -25300;

export function keychainKey(service: string, account: string): string {
  return `${service}\u0000${account}`;
}

function result(ok: boolean, stdout = "", stderr = ""): CommandResult {
  return { ok, code: ok ? 0 : NOT_FOUND_EXIT_CODE, stdout, stderr, unavailable: false };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** The modification time the fake reports for an entry nobody has written through it. */
export const SEEDED_MODIFIED_AT = "20260101000000Z";

/**
 * `modifiedAt` holds each entry's modification time as `YYYYMMDDhhmmssZ`; writes through the fake
 * stamp the current second, and entries missing from it report {@link SEEDED_MODIFIED_AT}.
 */
export function fakeMacosKeychain(
  entries: Map<string, string>,
  modifiedAt: Map<string, string> = new Map(),
): KeyringCommandRunner {
  const attributes = (key: string, account: string): string =>
    `attributes:\n    "acct"<blob>="${account}"\n` +
    `    "mdat"<timedate>=0x00  "${modifiedAt.get(key) ?? SEEDED_MODIFIED_AT}\\000"\n`;
  const answer = (args: readonly string[]): CommandResult => {
    const service = flag(args, "-s") ?? "";
    const account = flag(args, "-a");
    switch (args[0]) {
      case "find-generic-password": {
        if (account === undefined || !args.includes("-w")) {
          const match = [...entries.keys()].find((entry) =>
            account === undefined
              ? entry.startsWith(`${service}\u0000`)
              : entry === keychainKey(service, account),
          );
          if (match === undefined) {
            return result(false);
          }
          const matchedAccount = match.slice(service.length + 1);
          return result(true, attributes(match, matchedAccount));
        }
        const value = entries.get(keychainKey(service, account));
        return value === undefined ? result(false) : result(true, `${value}\n`);
      }
      case "add-generic-password": {
        const key = keychainKey(service, account ?? "");
        entries.set(key, flag(args, "-w") ?? "");
        modifiedAt.set(key, `${new Date().toISOString().slice(0, 19).replace(/\D/g, "")}Z`);
        return result(true);
      }
      case "delete-generic-password":
        return result(entries.delete(keychainKey(service, account ?? "")));
      default:
        return result(false);
    }
  };

  /** Like `security -i`, the session exits with its last command's status. */
  const session = (script: string): CommandResult => {
    let stdout = "";
    let stderr = "";
    let lastCode = 0;
    for (const line of script.split("\n").filter((line) => line !== "")) {
      const command = line.split(" ")[0] ?? "";
      if (Buffer.byteLength(line) > SECURITY_INTERACTIVE_LINE_LIMIT) {
        stderr += `security: unknown command "${line.slice(-30)}"\n${command}: returned 1\n`;
        lastCode = 1;
        continue;
      }
      const answered = answer(line.split(" "));
      lastCode = answered.code ?? 0;
      if (answered.ok) {
        stdout += answered.stdout;
      } else {
        stderr += `${command}: returned ${NOT_FOUND_STATUS}\n`;
      }
    }
    return { ok: lastCode === 0, code: lastCode, stdout, stderr, unavailable: false };
  };

  return (command, args, stdin) =>
    Effect.sync(() => {
      if (command === "osascript") {
        const item = JSON.parse(stdin ?? "") as { service: string; account: string };
        const value = entries.get(keychainKey(item.service, item.account));
        return value === undefined
          ? result(true, `${NOT_FOUND_STATUS}\n`)
          : result(true, `0:${Buffer.from(value).toString("base64")}\n`);
      }
      return args[0] === "-i" ? session(stdin ?? "") : answer(args);
    });
}

export function encodeVault(secrets: Record<string, string>): string {
  return Buffer.from(JSON.stringify(secrets)).toString("base64");
}

/** Chunk entries holding `secrets` as a one-chunk generation in slot `a`. */
export function chunkedVaultEntries(
  service: string,
  secrets: Record<string, string>,
  generation = 1,
): Record<string, string> {
  return {
    [keychainKey(service, "vault.a.0")]: `a.${generation}.0.1.${encodeVault(secrets)}`,
  };
}

/** The secrets of the newest complete vault generation under `service`, or undefined. */
export function chunkedVaultIn(
  entries: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  service: string,
): Record<string, string> | undefined {
  const pairs: readonly (readonly [string, string])[] =
    entries instanceof Map
      ? [...(entries as ReadonlyMap<string, string>)]
      : Object.entries(entries as Readonly<Record<string, string>>);
  const lines = pairs
    .filter(([key]) => key.startsWith(`${service}\u0000vault.`))
    .map(([, value]) => value);
  const { encoded } = assembleMacosVault(lines);
  return encoded === undefined
    ? undefined
    : (JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, string>);
}
