/**
 * Reads a generic-password item through macOS Security.framework using the system JavaScript bridge,
 * the way 0.16.19 and 0.16.20 wrote each home's vault. The login keychain asks for its password
 * whenever an item is read by a program other than the one that wrote it, so only `osascript` reads
 * those items silently. The fixed script receives JSON on stdin, keeping item names out of argv. An
 * explicit keychain path supports isolated integration tests.
 */
import { Effect } from "effect";
import type { KeyringCommandRunner } from "./keyring";

export interface MacosKeychainItem {
  readonly service: string;
  readonly account: string;
  readonly keychainPath?: string;
}

/**
 * `refused` is a password dialog that was denied, cancelled, left unanswered, or could not be
 * shown; `failed` is anything else, such as a missing `osascript` or a transient keychain error.
 */
export type MacosKeychainRead =
  | { readonly status: "ok"; readonly value: string }
  | { readonly status: "absent" }
  | { readonly status: "refused" }
  | { readonly status: "failed" };

/** Security.framework's errSecItemNotFound. */
const ITEM_NOT_FOUND_STATUS = "-25300";

/**
 * Security.framework statuses for a dialog that did not grant access: errSecUserCanceled (-128),
 * errSecAuthFailed (-25293, what Deny returns), and errSecInteractionNotAllowed (-25308, no dialog
 * could be shown).
 */
const DIALOG_REFUSED_STATUSES = new Set(["-128", "-25293", "-25308"]);

/**
 * Prints `0:<base64 of the item's data>`, or the nonzero Security.framework status. The JavaScript
 * bridge takes Security.framework's CFString dictionary keys directly.
 */
export const MACOS_KEYCHAIN_READ_SCRIPT = `
ObjC.import('Security');
ObjC.import('Foundation');
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, 4)));
  var query = {class: 'genp', svce: payload.service, acct: payload.account,
               r_Data: true, m_Limit: 'm_LimitOne'};
  if (payload.keychainPath !== undefined) {
    var opened = Ref();
    var openStatus = $.SecKeychainOpen(payload.keychainPath, opened);
    if (openStatus !== 0) return String(openStatus);
    query.m_SearchList = [ObjC.castRefToObject(opened[0])];
  }
  var result = Ref();
  var status = $.SecItemCopyMatching($(query), result);
  if (status !== 0) return String(status);
  return '0:' + ObjC.unwrap(ObjC.castRefToObject(result[0]).base64EncodedStringWithOptions(0));
}
`;

/** Reads an item's value as UTF-8, telling a refused dialog apart from other failures. */
export function readMacosKeychainItem(
  run: KeyringCommandRunner,
  item: MacosKeychainItem,
  timeoutMs?: number,
): Effect.Effect<MacosKeychainRead> {
  return run(
    "osascript",
    ["-l", "JavaScript", "-e", MACOS_KEYCHAIN_READ_SCRIPT],
    JSON.stringify(item),
    timeoutMs,
  ).pipe(
    Effect.map((result): MacosKeychainRead => {
      const output = result.stdout.trim();
      if (result.timedOut === true) {
        return { status: "refused" };
      }
      if (!result.ok) {
        return { status: "failed" };
      }
      if (DIALOG_REFUSED_STATUSES.has(output)) {
        return { status: "refused" };
      }
      if (output === ITEM_NOT_FOUND_STATUS) {
        return { status: "absent" };
      }
      if (!output.startsWith("0:")) {
        return { status: "failed" };
      }
      return { status: "ok", value: Buffer.from(output.slice(2), "base64").toString("utf8") };
    }),
  );
}
