/**
 * Persistent, append-only provenance for whole-file copies of protected credentials.
 *
 * Call `registerProtectedFileRoots` before creating destination, staging, or backup bytes.
 * Readers reload `getProtectedFileRoots` on each tool call; corrupt or inaccessible state
 * fails closed. Entries contain paths only, never credentials. Both lexical paths and paths
 * through existing symlinked ancestors are retained, including destinations not yet created.
 * `assertNotProtectionStateMutation` prevents built-in tools from replacing this registry,
 * its working files, or their ancestors. This home-scoped record is not an OS or shell sandbox.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonFileDurably } from "./durable-file";
import { withFileLock } from "./file-lock";
import { isRecord } from "./is-record";
import { getJazzHomeDirectory } from "./paths";

const STATE_ERROR = "Protected-file state is unavailable; credential protection remains enforced.";
const MUTATION_ERROR = "Refused to modify protected-file tracking state or its parent directory.";

/** Discard filesystem/parser causes because they can contain protected paths or file contents. */
function stateError(): Error {
  return new Error(STATE_ERROR);
}

/** The private registry for the current Jazz home; resolved at call time. */
export function getProtectedFilesRegistryPath(): string {
  return path.resolve(getJazzHomeDirectory(), ".protected-files.json");
}

/** Resolve existing ancestors without requiring the final destination to exist yet. */
function canonicalDestination(location: string): string {
  let ancestor = path.resolve(location);
  const tail: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(ancestor), ...tail);
    } catch (error) {
      if (!isRecord(error) || error["code"] !== "ENOENT") throw stateError();
      try {
        fs.lstatSync(ancestor);
        throw stateError();
      } catch (statError) {
        if (!isRecord(statError) || statError["code"] !== "ENOENT") {
          throw stateError();
        }
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw stateError();
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function readRoots(registry: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registry, "utf8"));
    if (
      !isRecord(parsed) ||
      parsed["version"] !== 1 ||
      !Array.isArray(parsed["roots"]) ||
      !parsed["roots"].every(
        (entry: unknown) =>
          typeof entry === "string" && path.isAbsolute(entry) && !entry.includes("\0"),
      )
    ) {
      throw stateError();
    }
    return parsed["roots"] as string[];
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      try {
        fs.lstatSync(registry);
      } catch (statError) {
        if (isRecord(statError) && statError["code"] === "ENOENT") return [];
      }
    }
    throw stateError();
  }
}

/** Reload durable provenance; absence means a new home, other read failures deny access. */
export function getProtectedFileRoots(): readonly string[] {
  return readRoots(getProtectedFilesRegistryPath());
}

/** Persist all spellings before any protected bytes are copied; marks are never removed. */
export async function registerProtectedFileRoots(locations: readonly string[]): Promise<void> {
  const registry = getProtectedFilesRegistryPath();
  try {
    const spellings = locations.flatMap((location) => {
      if (!path.isAbsolute(location) || location.includes("\0")) throw stateError();
      return [path.normalize(location), canonicalDestination(location)];
    });
    await withFileLock(`${registry}.lock`, async () => {
      const roots = [...new Set([...readRoots(registry), ...spellings])];
      await writeJsonFileDurably(registry, { version: 1, roots }, { mode: 0o600 });
    });
  } catch {
    throw stateError();
  }
}

function fold(location: string): string {
  return process.platform === "darwin" || process.platform === "win32"
    ? location.toLowerCase()
    : location;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Reject destructive operations on registry state, its lock/temp siblings, or ancestors. */
export function assertNotProtectionStateMutation(location: string): void {
  const registry = getProtectedFilesRegistryPath();
  const targets = [path.resolve(location), canonicalDestination(location)].map(fold);
  const registries = [registry, canonicalDestination(registry)].map(fold);
  for (const target of targets) {
    for (const state of registries) {
      const lock = `${state}.lock`;
      if (
        contains(target, state) ||
        contains(lock, target) ||
        contains(`${lock}.guard`, target) ||
        (path.dirname(target) === path.dirname(state) &&
          ((path.basename(target).startsWith(`.${path.basename(state)}-`) &&
            target.endsWith(".tmp")) ||
            target.startsWith(`${state}.corrupt-`)))
      ) {
        throw new Error(MUTATION_ERROR);
      }
    }
  }
}
