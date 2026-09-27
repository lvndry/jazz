/**
 * Keep credential bytes inside whole-file transfers. Before cp/mv writes anything, persist
 * protection for the destination. Directory transfers conservatively protect the whole tree
 * when any source descendant is protected. Only names and filesystem metadata are inspected.
 * Records are retained after failure or deletion so interruption cannot declassify a copy.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  assertNotProtectionStateMutation,
  registerProtectedFileRoots,
} from "@/core/utils/protected-files";
import { loadSecretPathRules, secretPathReason } from "@/core/utils/secret-paths";

/** Check source descendants, following aliases with cycle detection, without reading bytes. */
async function containsProtectedFile(source: string): Promise<boolean> {
  const rules = loadSecretPathRules();
  const pending = [source];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (secretPathReason(candidate, rules) !== undefined) return true;
    let canonical: string;
    try {
      canonical = await fs.realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Cannot inspect transfer source protection.", { cause: error });
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const stat = await fs.stat(canonical);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(canonical)) pending.push(path.join(canonical, entry));
    }
  }
  return false;
}

/** Reserve protection before transfer; failure must prevent copying, never fall back unmarked. */
export async function protectFileTransfer(source: string, destination: string): Promise<boolean> {
  assertNotProtectionStateMutation(destination);
  const protectedTransfer =
    secretPathReason(destination) !== undefined || (await containsProtectedFile(source));
  if (protectedTransfer) await registerProtectedFileRoots([destination]);
  return protectedTransfer;
}
