/**
 * Keep `$JAZZ_HOME` unreadable to other accounts.
 *
 * `securePrivateHome` runs once at every CLI start, synchronously, before the command's action
 * (and after `--data-dir` has chosen the home). It creates the home owner-only when it is
 * missing and clears the non-owner bits on the home directory itself every time (one stat). The
 * first time it sees a home, it also walks everything under it and clears the same bits on each
 * file and directory this account owns, then leaves a marker so later starts skip the walk. That
 * walk is the repair for homes created before Jazz wrote its files privately; writers keep new
 * files private on their own (see `private-mode.ts`).
 *
 * Owner bits (including execute, which skill and plugin scripts need) are never touched, nor
 * are symbolic links or entries another account owns. In a group-shared home (setgid, as the
 * chat bridges provision) only the "other" bits are cleared.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import {
  nonOwnerBitsToClear,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from "@/core/utils/private-mode";

/** Marker left in the home once the one-time walk has run. */
export const PERMISSION_REPAIR_MARKER = ".permissions-repaired";

/** Bumped when the repair learns something new, so existing homes are walked once more. */
const PERMISSION_REPAIR_VERSION = "1";

/** All permission bits, including setuid, setgid and sticky. */
const ALL_PERMISSION_BITS = 0o7777;

function clearBits(target: string, bits: number, uid: number | undefined): void {
  const stats = nodeFs.lstatSync(target);
  if (stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid)) {
    return;
  }
  const mode = stats.mode & ALL_PERMISSION_BITS;
  if ((mode & bits) !== 0) {
    nodeFs.chmodSync(target, mode & ~bits);
  }
}

/** Clear `bits` on everything under `directory`; returns how many entries could not be fixed. */
function repairTree(directory: string, bits: number, uid: number | undefined): number {
  let failures = 0;
  let entries: nodeFs.Dirent[];
  try {
    entries = nodeFs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 1;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    try {
      clearBits(target, bits, uid);
    } catch {
      failures += 1;
      continue;
    }
    if (entry.isDirectory()) {
      failures += repairTree(target, bits, uid);
    }
  }
  return failures;
}

export interface PrivateHomeReport {
  /** Whether the one-time walk ran on this start. */
  readonly repaired: boolean;
  /** Entries whose mode could not be read or changed during the walk. */
  readonly failures: number;
}

/** Make `home` (default `$JAZZ_HOME`) private, running the one-time repair when it is due. */
export function securePrivateHome(home: string = getJazzHomeDirectory()): PrivateHomeReport {
  const uid = process.getuid?.();
  nodeFs.mkdirSync(home, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const bits = nonOwnerBitsToClear(home);
  clearBits(home, bits, uid);

  const marker = path.join(home, PERMISSION_REPAIR_MARKER);
  let recorded: string | undefined;
  try {
    recorded = nodeFs.readFileSync(marker, "utf8");
  } catch {
    recorded = undefined;
  }
  if (recorded?.trim() === PERMISSION_REPAIR_VERSION) {
    return { repaired: false, failures: 0 };
  }
  const failures = repairTree(home, bits, uid);
  if (failures === 0) {
    nodeFs.writeFileSync(marker, `${PERMISSION_REPAIR_VERSION}\n`, { mode: PRIVATE_FILE_MODE });
  }
  return { repaired: true, failures };
}
