/**
 * Nonblocking cleanup participant in Jazz's existing conversation-turn lock protocol.
 * Uses the same .turn directory, owner.json record and .guard as file-lock.ts, but all writes
 * and removals remain anchored to directory descriptors. Cleanup never reclaims another lease.
 * Hold the returned release across protection checks and traversal, then release in finally.
 */
import { randomUUID } from "node:crypto";
import { FILE_LOCK_PROTOCOL } from "@jazz/core/utils/file-lock";
import { currentProcessOwner } from "@jazz/core/utils/process";
import { SweepDirectory, isMissingSweepPath } from "./sweep-directory";

function codeIs(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Opens or creates lock ancestors without following links or crossing mounts. */
export function leaseDirectory(home: SweepDirectory, agent: string): SweepDirectory {
  let current: SweepDirectory | undefined;
  try {
    for (const name of ["history", "conversation-locks", agent]) {
      const parent = current ?? home;
      let next;
      try {
        next = parent.child(name);
      } catch (error) {
        if (!isMissingSweepPath(error)) {
          throw error;
        }
        try {
          next = parent.createChild(name);
        } catch (created) {
          if (!codeIs(created, "EEXIST")) {
            throw created;
          }
          next = parent.child(name);
        }
      }
      current?.close();
      current = next;
    }
    if (current === undefined) {
      throw new Error("Missing lease parent");
    }
    return current;
  } catch (error) {
    current?.close();
    throw error;
  }
}

export async function trySweepConversationLease(
  home: SweepDirectory,
  agent: string,
  conversation: string,
): Promise<(() => Promise<void>) | undefined> {
  const parent = leaseDirectory(home, agent);
  const name = `${conversation}.turn`;
  let lease: SweepDirectory;
  try {
    lease = parent.createChild(name);
  } catch (error) {
    parent.close();
    if (codeIs(error, "EEXIST")) {
      return undefined;
    }
    throw error;
  }
  const token = randomUUID();
  const release = async (): Promise<void> => {
    const deadline = Date.now() + FILE_LOCK_PROTOCOL.guardStaleMs * 2;
    try {
      for (;;) {
        let guard: SweepDirectory;
        try {
          guard = parent.createChild(`${name}${FILE_LOCK_PROTOCOL.guardSuffix}`);
        } catch (error) {
          if (!codeIs(error, "EEXIST")) {
            throw error;
          }
          try {
            if (
              Date.now() - parent.stat(`${name}${FILE_LOCK_PROTOCOL.guardSuffix}`).mtimeMs >
              FILE_LOCK_PROTOCOL.guardStaleMs
            ) {
              try {
                parent.remove(`${name}${FILE_LOCK_PROTOCOL.guardSuffix}`, true);
              } catch (removed) {
                if (!isMissingSweepPath(removed)) {
                  throw removed;
                }
              }
            }
          } catch (inspection) {
            if (!isMissingSweepPath(inspection)) {
              throw inspection;
            }
          }
          if (Date.now() >= deadline) {
            throw new Error("Cleanup lease release guard remained busy", { cause: error });
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          continue;
        }
        try {
          if (parent.owns(name, lease)) {
            try {
              lease.remove(FILE_LOCK_PROTOCOL.holderFile);
            } catch (error) {
              if (!isMissingSweepPath(error)) {
                throw error;
              }
            }
            parent.remove(name, true);
          }
          return;
        } catch (error) {
          if (!isMissingSweepPath(error)) {
            throw error;
          }
          return;
        } finally {
          guard.close();
          parent.remove(`${name}${FILE_LOCK_PROTOCOL.guardSuffix}`, true);
        }
      }
    } finally {
      lease.close();
      parent.close();
    }
  };
  try {
    lease.writeExclusive(
      FILE_LOCK_PROTOCOL.holderFile,
      JSON.stringify({ ...currentProcessOwner(), token }),
    );
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
