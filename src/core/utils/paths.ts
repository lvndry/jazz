import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolves Jazz's user, project, and package directories.
 *
 * User data always lives under `JAZZ_HOME` when set, otherwise `~/.jazz`.
 * The project-local `./.jazz` directory is reserved for optional overrides;
 * development mode does not change the user-data location.
 */

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
 * Returns the directory for per-agent memory shared across invocation surfaces.
 */
export function getMemoryDirectory(): string {
  return path.join(getJazzHomeDirectory(), "memory");
}

/**
 * Finds the `jazz-ai` package root containing `package.json`.
 *
 * @returns The package root directory, or `null` when it cannot be found.
 */
export function getPackageRootDirectory(): string | null {
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
