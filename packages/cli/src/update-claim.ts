import fs from "node:fs";
import path from "node:path";
import { stateFileMode } from "@jazz/core/utils/private-mode";

const UPDATE_CLAIM_FILE = "update_install_claim";

/** Longest a background install may run before another process may take over its claim. */
export const UPDATE_CLAIM_TTL_MS = 30 * 60 * 1000;

/**
 * Takes the per-home right to run a background install. The claim is an exclusively created
 * file, so of several Jazz processes starting together exactly one wins; a claim older than
 * {@link UPDATE_CLAIM_TTL_MS} belongs to an installer that died and is taken over.
 *
 * @returns Whether this process now owns the claim.
 */
export function tryClaimUpdateInstall(dataDirectory: string, now: number = Date.now()): boolean {
  const claimPath = path.join(dataDirectory, UPDATE_CLAIM_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(claimPath, String(now), { flag: "wx", mode: stateFileMode() });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return false;
      }
      try {
        if (now - fs.statSync(claimPath).mtimeMs < UPDATE_CLAIM_TTL_MS) {
          return false;
        }
      } catch {
        continue;
      }
      fs.rmSync(claimPath, { force: true });
    }
  }
  return false;
}

/** Gives up the claim so the next check may install again. */
export function releaseUpdateInstallClaim(dataDirectory: string): void {
  fs.rmSync(path.join(dataDirectory, UPDATE_CLAIM_FILE), { force: true });
}
