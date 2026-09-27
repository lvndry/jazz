/** Reading and seeding the files a sample keeps: logs, memory, and agent definitions. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Each non-empty line of an NDJSON file parsed, empty when the file does not exist. */
export function readJsonLines<Line>(path: string): Line[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Line);
}

export interface WalkOptions {
  /** List symlinks as files instead of skipping them. They are never followed either way. */
  readonly includeSymlinks?: boolean;
  /** Skip files whose name starts with a dot; dot-directories are still walked. */
  readonly skipDotfiles?: boolean;
  /** Keep only files whose name ends with this, e.g. `.md`. */
  readonly extension?: string;
}

/**
 * Sorted absolute paths of the files under `root`, empty when it does not exist. Symlinks are
 * never followed, so a walk cannot leave the sample's directory or loop on a cycle.
 */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const listed = entry.isFile() || (options.includeSymlinks === true && entry.isSymbolicLink());
      if (
        listed &&
        !(options.skipDotfiles === true && entry.name.startsWith(".")) &&
        (options.extension === undefined || entry.name.endsWith(options.extension))
      ) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found.sort();
}

export interface MemoryEntry {
  /** Path under `memory/`, e.g. `personal/when/food/partner-diet.md`. */
  path: string;
  content: string;
}

/** Every memory entry in a Jazz home, sidecar files excluded. */
export function memoryEntries(jazzHome: string): MemoryEntry[] {
  const root = join(jazzHome, "memory");
  return walkFiles(root, { skipDotfiles: true, extension: ".md" }).map((path) => ({
    path: relative(root, path),
    content: readFileSync(path, "utf8"),
  }));
}

/** Merge `changes` into the config of an agent already defined in a Jazz home. */
export function updateAgentConfig(
  jazzHome: string,
  agentId: string,
  changes: Record<string, unknown>,
): void {
  const agentPath = join(jazzHome, "agents", `${agentId}.json`);
  const agent = JSON.parse(readFileSync(agentPath, "utf-8")) as {
    config: Record<string, unknown>;
  };
  Object.assign(agent.config, changes);
  writeFileSync(agentPath, `${JSON.stringify(agent, null, 2)}\n`);
}
