/**
 * Writes a generic-password item through macOS Security.framework using the system JavaScript
 * bridge. The fixed script receives JSON on stdin, so neither process arguments nor the
 * `security -i` command parser carry credentials. New items trust the `security` reader as well
 * as their creating process. An explicit keychain path supports isolated integration tests.
 */
import { Effect } from "effect";
import type { KeyringCommandRunner } from "./keyring";

export interface MacosKeychainWrite {
  readonly service: string;
  readonly account: string;
  readonly value: string;
  readonly keychainPath?: string;
}

/** Security.framework's CFString dictionary keys are used directly by the JavaScript bridge. */
export const MACOS_KEYCHAIN_WRITE_SCRIPT = `
ObjC.import('Security');
ObjC.import('Foundation');
function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, 4)));
  var query = {class: 'genp', svce: payload.service, acct: payload.account};
  var keychain;
  if (payload.keychainPath !== undefined) {
    var opened = Ref();
    var status = $.SecKeychainOpen(payload.keychainPath, opened);
    if (status !== 0) return String(status);
    keychain = ObjC.castRefToObject(opened[0]);
    query.m_SearchList = [keychain];
  }
  var data = $(payload.value).dataUsingEncoding(4);
  var status = $.SecItemUpdate($(query), $({v_Data: data}));
  if (status !== -25300) return String(status);
  var trusted = Ref();
  status = $.SecTrustedApplicationCreateFromPath('/usr/bin/security', trusted);
  if (status !== 0) return String(status);
  var access = Ref();
  status = $.SecAccessCreate($('Jazz secrets'), $([ObjC.castRefToObject(trusted[0])]), access);
  if (status !== 0) return String(status);
  var item = {class: 'genp', svce: payload.service, acct: payload.account,
              v_Data: data, acls: ObjC.castRefToObject(access[0])};
  if (keychain !== undefined) item.u_Keychain = keychain;
  return String($.SecItemAdd($(item), null));
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
