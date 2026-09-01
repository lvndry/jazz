/**
 * Resolves Jazz's user, project, and package directories.
 *
 * User data always lives under `JAZZ_HOME` when set, otherwise `~/.jazz`.
 * The project-local `./.jazz` directory is reserved for optional overrides;
 * development mode does not change the user-data location.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractEmbeddedAssets,
  hasEmbeddedAssets,
  pruneStaleAssetDirectories,
} from "@/core/assets/asset-extraction";
import { storageSafeSegment } from "@/core/utils/storage-id";
import packageJson from "../../../../package.json";

function expandHomePath(inputPath: string): string {
  if (inputPath.startsWith("~")) {
    const homeDir = os.homedir();
    if (homeDir && homeDir.trim().length > 0) {
      return inputPath.replace(/^~(?=$|[\\/])/, homeDir);
    }
  }
  return inputPath;
}

/**
 * Returns the Jazz home directory used for agents, configuration, and user data.
 *
 * Uses `JAZZ_HOME` when set, otherwise `~/.jazz`. If the operating-system home
 * directory is unavailable, falls back to `{cwd}/.jazz`.
 */
export function getJazzHomeDirectory(): string {
  const jazzHome = process.env["JAZZ_HOME"];
  if (jazzHome && jazzHome.trim().length > 0) {
    return path.resolve(expandHomePath(jazzHome.trim()));
  }

  const homeDir = os.homedir();
  if (homeDir && homeDir.trim().length > 0) {
    return path.join(homeDir, ".jazz");
  }

  return path.resolve(process.cwd(), ".jazz");
}

/**
 * Returns `{cwd}/.jazz`, the directory for optional project-local overrides.
 */
export function getLocalJazzDirectory(): string {
  return path.resolve(process.cwd(), ".jazz");
}

/**
 * Returns the Jazz home directory used for user data.
 */
export function getUserDataDirectory(): string {
  return getJazzHomeDirectory();
}

/**
 * Returns the Jazz home directory used for global user data.
 */
export function getGlobalUserDataDirectory(): string {
  return getJazzHomeDirectory();
}

/**
 * Returns the directory for per-agent conversation history.
 */
export function getHistoryDirectory(): string {
  return path.join(getJazzHomeDirectory(), "history");
}

/**
 * Returns the directory holding one JSON file per run lifecycle record.
 *
 * Separate from history because the two have different lifetimes: a conversation log is
 * the permanent transcript of what was said, while a run record is small, churns on every
 * state change, and is prunable once terminal.
 */
export function getRunsDirectory(): string {
  return path.join(getJazzHomeDirectory(), "runs");
}

/**
 * Returns the directory for per-agent memory shared across invocation surfaces.
 */
export function getMemoryDirectory(): string {
  return path.join(getJazzHomeDirectory(), "memory");
}

/**
 * Returns the directory for per-agent durable scratch space.
 *
 * Deliberately separate from the memory directory: memory is small, curated
 * notes; this is where large working drafts, research dumps, and
 * intermediate artifacts live, referenced from memory rather than duplicated
 * into it. Also separate from `getWorkStateDirectory`, which is per-task
 * compaction bookkeeping discarded when a conversation ends — workspace
 * content is durable across conversations, like memory.
 */
export function getWorkspaceDirectory(): string {
  return path.join(getJazzHomeDirectory(), "workspace");
}

/**
 * Returns the directory holding the tool-misfire log: a JSONL record of failed
 * tool calls (runtime errors, tool-not-found, schema mismatches) kept separate
 * from ordinary logs so it can be mined later for recurring failure patterns.
 */
export function getMisfireLogDirectory(): string {
  return path.join(getJazzHomeDirectory(), "misfires");
}

let embeddedAssetRoot: string | null | undefined;

/**
 * Returns the directory a standalone binary unpacks its built-in assets into.
 *
 * Resolved once per process: the unpack itself is a no-op after the first run,
 * but `getPackageRootDirectory` is called often enough that the existence check
 * is worth skipping.
 *
 * @returns The unpacked directory, or `null` outside a standalone binary.
 */
function getEmbeddedAssetRoot(): string | null {
  if (embeddedAssetRoot !== undefined) {
    return embeddedAssetRoot;
  }

  if (!hasEmbeddedAssets()) {
    embeddedAssetRoot = null;
    return embeddedAssetRoot;
  }

  const runtimeRoot = path.join(getJazzHomeDirectory(), "runtime");
  embeddedAssetRoot = extractEmbeddedAssets(path.join(runtimeRoot, packageJson.version));
  pruneStaleAssetDirectories(runtimeRoot, packageJson.version);
  return embeddedAssetRoot;
}

/**
 * Directory holding per-conversation working state: the compaction journal and the
 * agent-maintained task state.
 *
 * Deliberately separate from the memory directory. Memory is what stays true about a
 * person or project across conversations; this is where one task stands right now, and
 * it is discarded when that task is done.
 *
 * Both segments are sanitized because a conversation id is no longer always machine-minted:
 * a threaded webhook trigger derives one from a caller-supplied thread key, and a raw
 * `../../..` joined in here would be an arbitrary-path write from an authenticated caller.
 */
export function getWorkStateDirectory(agentId: string, conversationId: string): string {
  return path.join(
    getJazzHomeDirectory(),
    "work",
    storageSafeSegment(agentId),
    storageSafeSegment(conversationId),
  );
}

/**
 * Finds the `jazz-ai` package root containing `package.json`.
 *
 * @returns The package root directory, or `null` when it cannot be found.
 */
export function getPackageRootDirectory(): string | null {
  const unpackedAssets = getEmbeddedAssetRoot();
  if (unpackedAssets) {
    return unpackedAssets;
  }

  try {
    let currentDir = path.resolve(import.meta.dirname);
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const packageJsonPath = path.join(currentDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const content = fs.readFileSync(packageJsonPath, "utf-8");
          const pkg = JSON.parse(content) as { name?: string };
          if (pkg.name === "jazz-ai") {
            return currentDir;
          }
        } catch {
          // Can't read/parse package.json, continue searching
        }
      }
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // Can't determine package directory
  }

  return null;
}

/**
 * Finds the directory containing built-in skills shipped with Jazz.
 *
 * @returns The package's `skills` directory, or `null` when unavailable.
 */
export function getBuiltinSkillsDirectory(): string | null {
  const packageDir = getPackageRootDirectory();
  if (!packageDir) {
    return null;
  }

  const skillsDir = path.join(packageDir, "skills");
  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    return skillsDir;
  }

  return null;
}

/**
 * Returns the global user-skills directory under the resolved Jazz home.
 */
export function getGlobalSkillsDirectory(): string {
  return path.join(getJazzHomeDirectory(), "skills");
}

/**
 * Returns the shared cross-tool agent-skills directory at `~/.agents/skills`.
 */
export function getAgentsSkillsDirectory(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".agents", "skills");
}

/**
 * Finds the directory containing built-in personas shipped with Jazz.
 *
 * @returns The package's `personas` directory, or `null` when unavailable.
 */
export function getBuiltinPersonasDirectory(): string | null {
  const packageDir = getPackageRootDirectory();
  if (!packageDir) {
    return null;
  }

  const personasDir = path.join(packageDir, "personas");
  if (fs.existsSync(personasDir) && fs.statSync(personasDir).isDirectory()) {
    return personasDir;
  }

  return null;
}

/**
 * Finds the directory containing built-in workflows shipped with Jazz.
 *
 * @returns The package's `workflows` directory, or `null` when unavailable.
 */
export function getBuiltinWorkflowsDirectory(): string | null {
  const packageDir = getPackageRootDirectory();
  if (!packageDir) {
    return null;
  }

  const workflowsDir = path.join(packageDir, "workflows");
  if (fs.existsSync(workflowsDir) && fs.statSync(workflowsDir).isDirectory()) {
    return workflowsDir;
  }

  return null;
}

/**
 * Returns the global user-workflows directory under the resolved Jazz home.
 */
export function getGlobalWorkflowsDirectory(): string {
  return path.join(getJazzHomeDirectory(), "workflows");
}
