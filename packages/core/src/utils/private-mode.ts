/**
 * The permission bits Jazz gives everything it writes under `$JAZZ_HOME`: conversations,
 * memory, logs and state are readable by their owner only, so another account on a shared
 * machine cannot read them.
 *
 * One exception: a home whose directory carries the setgid bit is shared with a group on
 * purpose. The chat bridges provision each conversation's home that way (setgid, group =
 * the operator) so the operator can read what the conversation's own account writes. In such a
 * home Jazz keeps group read and clears only the bits for everyone else.
 *
 * Writers call {@link stateFileMode} and {@link stateDirectoryMode} rather than hard-coding a
 * mode; the startup repair (`private-home.ts`) clears {@link nonOwnerBitsToClear}.
 */

import * as fs from "node:fs";
import { getJazzHomeDirectory } from "@/core/utils/paths";

/** Owner read and write. */
export const PRIVATE_FILE_MODE = 0o600;

/** Owner read, write and traverse. */
export const PRIVATE_DIRECTORY_MODE = 0o700;

/** Owner read and write, group read: a file in a group-shared home. */
const GROUP_SHARED_FILE_MODE = 0o640;

/** Owner full, group read and traverse: a directory in a group-shared home. */
const GROUP_SHARED_DIRECTORY_MODE = 0o750;

/** Group and other bits. */
const GROUP_AND_OTHER_BITS = 0o077;

/** Other bits only. */
const OTHER_BITS = 0o007;

/** The set-group-id bit, which on a directory makes new entries inherit its group. */
const SET_GROUP_ID_BIT = 0o2000;

const groupSharedByHome = new Map<string, boolean>();

/**
 * Whether `home` is shared with its group on purpose (its directory is setgid). Cached per
 * home once the directory exists.
 */
export function isGroupSharedHome(home: string = getJazzHomeDirectory()): boolean {
  const cached = groupSharedByHome.get(home);
  if (cached !== undefined) {
    return cached;
  }
  let shared: boolean;
  try {
    shared = (fs.statSync(home).mode & SET_GROUP_ID_BIT) !== 0;
  } catch {
    return false;
  }
  groupSharedByHome.set(home, shared);
  return shared;
}

/** The mode for a new state file under the current Jazz home. */
export function stateFileMode(): number {
  return isGroupSharedHome() ? GROUP_SHARED_FILE_MODE : PRIVATE_FILE_MODE;
}

/** The mode for a new state directory under the current Jazz home. */
export function stateDirectoryMode(): number {
  return isGroupSharedHome() ? GROUP_SHARED_DIRECTORY_MODE : PRIVATE_DIRECTORY_MODE;
}

/** The permission bits the startup repair clears from what is already under `home`. */
export function nonOwnerBitsToClear(home: string = getJazzHomeDirectory()): number {
  return isGroupSharedHome(home) ? OTHER_BITS : GROUP_AND_OTHER_BITS;
}
