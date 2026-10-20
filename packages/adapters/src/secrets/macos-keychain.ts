/**
 * Reads and writes generic-password items through macOS Security.framework using the system
 * JavaScript bridge. The fixed scripts receive JSON on stdin, so neither process arguments nor the
 * `security -i` command parser carry credentials. An explicit keychain path supports isolated
 * integration tests.
 *
 * Every read of an item this module writes must go through {@link readMacosKeychainItem}. The login
 * keychain ties an item to the program that last wrote its value: `/usr/bin/security` asks for the
 * keychain password on every read of an `osascript`-written item, even when the item's access list
 * trusts it, and "Always Allow" does not stop the prompts.
 */
import { Effect } from "effect";
import type { KeyringCommandRunner } from "./keyring";

export interface MacosKeychainItem {
  readonly service: string;
  readonly account: string;
  readonly keychainPath?: string;
}

export interface MacosKeychainWrite extends MacosKeychainItem {
  readonly value: string;
}

export type MacosKeychainRead =
  | { readonly status: "ok"; readonly value: string }
  | { readonly status: "absent" }
  | { readonly status: "failed" };

/** Security.framework's errSecItemNotFound. */
const ITEM_NOT_FOUND_STATUS = "-25300";

/** Opens the payload's keychain, when it names one, and scopes `query` to it. */
const KEYCHAIN_SCOPE = `
  var keychain;
  if (payload.keychainPath !== undefined) {
    var opened = Ref();
    var openStatus = $.SecKeychainOpen(payload.keychainPath, opened);
    if (openStatus !== 0) return String(openStatus);
    keychain = ObjC.castRefToObject(opened[0]);
    query.m_SearchList = [keychain];
  }`;

const READ_PAYLOAD = `
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, 4)));
  var query = {class: 'genp', svce: payload.service, acct: payload.account};`;

/** Security.framework's CFString dictionary keys are used directly by the JavaScript bridge. */
export const MACOS_KEYCHAIN_WRITE_SCRIPT = `
ObjC.import('Security');
ObjC.import('Foundation');
function run() {${READ_PAYLOAD}${KEYCHAIN_SCOPE}
  var data = $(payload.value).dataUsingEncoding(4);
  var status = $.SecItemUpdate($(query), $({v_Data: data}));
  if (status !== -25300) return String(status);
  var writer = Ref();
  status = $.SecTrustedApplicationCreateFromPath('/usr/bin/osascript', writer);
  if (status !== 0) return String(status);
  var access = Ref();
  status = $.SecAccessCreate($('Jazz secrets'), $([ObjC.castRefToObject(writer[0])]), access);
  if (status !== 0) return String(status);
  var item = {class: 'genp', svce: payload.service, acct: payload.account,
              v_Data: data, acls: ObjC.castRefToObject(access[0])};
  if (keychain !== undefined) item.u_Keychain = keychain;
  return String($.SecItemAdd($(item), null));
}
`;

/** Prints `0:<base64 of the item's data>`, or the nonzero Security.framework status. */
export const MACOS_KEYCHAIN_READ_SCRIPT = `
ObjC.import('Security');
ObjC.import('Foundation');
function run() {${READ_PAYLOAD}${KEYCHAIN_SCOPE}
  query.r_Data = true;
  query.m_Limit = 'm_LimitOne';
  var result = Ref();
  var status = $.SecItemCopyMatching($(query), result);
  if (status !== 0) return String(status);
  return '0:' + ObjC.unwrap(ObjC.castRefToObject(result[0]).base64EncodedStringWithOptions(0));
}
`;

/** Returns false on process failure or a nonzero Security.framework status, without secret diagnostics. */
export function writeMacosKeychainItem(
  run: KeyringCommandRunner,
  item: MacosKeychainWrite,
): Effect.Effect<boolean> {
  return run(
    "osascript",
    ["-l", "JavaScript", "-e", MACOS_KEYCHAIN_WRITE_SCRIPT],
    JSON.stringify(item),
  ).pipe(Effect.map((result) => result.ok && result.stdout.trim() === "0"));
}

/** Reads an item's value as UTF-8; anything but a clean hit or errSecItemNotFound is a failure. */
export function readMacosKeychainItem(
  run: KeyringCommandRunner,
  item: MacosKeychainItem,
): Effect.Effect<MacosKeychainRead> {
  return run(
    "osascript",
    ["-l", "JavaScript", "-e", MACOS_KEYCHAIN_READ_SCRIPT],
    JSON.stringify(item),
  ).pipe(
    Effect.map((result): MacosKeychainRead => {
      const output = result.stdout.trim();
      if (!result.ok) {
        return { status: "failed" };
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
