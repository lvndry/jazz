import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * AGENTS.md support — the cross-tool convention for project instructions
 * (https://agents.md). A repository drops an `AGENTS.md` at its root (and
 * optionally in subdirectories) describing build commands, conventions, and
 * house rules; every agent that reads the convention picks them up.
 */

export interface ProjectInstructionFile {
  readonly path: string;
  readonly content: string;
}

const INSTRUCTION_FILE_NAME = "AGENTS.md";

/**
 * Per-file byte cap. AGENTS.md files are meant to be short; a runaway file
 * (generated docs, a pasted changelog) would otherwise silently eat the whole
 * context window. Truncated content is marked so the model knows it is partial.
 */
const MAX_FILE_BYTES = 32 * 1024;

/**
 * Upper bound on how far the ancestor walk climbs when no repository root is
 * found. Guards against pathological paths and network mounts.
 */
const MAX_ANCESTOR_DEPTH = 32;

function readInstructionFile(filePath: string): ProjectInstructionFile | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;

    const raw = fs.readFileSync(filePath, "utf-8");
    if (raw.trim().length === 0) return null;

    if (Buffer.byteLength(raw, "utf-8") <= MAX_FILE_BYTES) {
      return { path: filePath, content: raw.trim() };
    }

    const truncated = Buffer.from(raw, "utf-8").subarray(0, MAX_FILE_BYTES).toString("utf-8");
    return {
      path: filePath,
      content: `${truncated.trim()}\n\n[truncated: ${INSTRUCTION_FILE_NAME} exceeds ${MAX_FILE_BYTES} bytes]`,
    };
  } catch {
    return null;
  }
}

function isRepositoryRoot(directory: string): boolean {
  try {
    return fs.existsSync(path.join(directory, ".git"));
  } catch {
    return false;
  }
}

/**
 * Collects the directories to scan, outermost first.
 *
 * The walk starts at `startDir` and climbs until it reaches a repository root
 * (inclusive), the user's home directory, or the filesystem root. Stopping at
 * the repository root is what keeps a checkout under `~/work` from inheriting
 * an unrelated `AGENTS.md` sitting in `~/work`.
 */
function collectDirectories(startDir: string, homeDirectory: string): readonly string[] {
  const directories: string[] = [];

  let currentDirectory = path.resolve(startDir);
  const filesystemRoot = path.parse(currentDirectory).root;

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    directories.push(currentDirectory);

    if (isRepositoryRoot(currentDirectory)) break;
    if (currentDirectory === homeDirectory) break;
    if (currentDirectory === filesystemRoot) break;

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }

  return directories.reverse();
}

/**
 * Discovers the AGENTS.md files that apply to `startDir`.
 *
 * Returned outermost-first so the nearest file lands last in the prompt: when
 * a nested `AGENTS.md` contradicts one further up, the more specific
 * instruction is the one the model reads most recently.
 *
 * A global `~/.agents/AGENTS.md` — the same shared location Jazz already reads
 * cross-tool skills from — comes first when present, so personal defaults sit
 * beneath anything the project says.
 */
export function discoverProjectInstructions(
  startDir: string,
  homeDirectory: string = os.homedir(),
): readonly ProjectInstructionFile[] {
  const candidatePaths: string[] = [];

  if (homeDirectory && homeDirectory.trim().length > 0) {
    candidatePaths.push(path.join(homeDirectory, ".agents", INSTRUCTION_FILE_NAME));
  }

  for (const directory of collectDirectories(startDir, homeDirectory)) {
    candidatePaths.push(path.join(directory, INSTRUCTION_FILE_NAME));
  }

  const seenPaths = new Set<string>();
  const files: ProjectInstructionFile[] = [];

  for (const candidatePath of candidatePaths) {
    if (seenPaths.has(candidatePath)) continue;
    seenPaths.add(candidatePath);

    const file = readInstructionFile(candidatePath);
    if (file) files.push(file);
  }

  return files;
}

/**
 * Renders discovered instruction files as a system-prompt section.
 *
 * Returns an empty string when nothing was found, so callers can concatenate
 * unconditionally.
 */
export function renderProjectInstructions(
  files: readonly ProjectInstructionFile[],
  homeDirectory: string = os.homedir(),
): string {
  if (files.length === 0) return "";

  const displayPath = (filePath: string): string =>
    homeDirectory && filePath.startsWith(`${homeDirectory}${path.sep}`)
      ? `~${filePath.slice(homeDirectory.length)}`
      : filePath;

  const blocks = files
    .map((file) => `<file path="${displayPath(file.path)}">\n${file.content}\n</file>`)
    .join("\n\n");

  return `
# Project instructions

The AGENTS.md files below were found in and above the current working directory. They are instructions from the people who own this project — follow them as you would the user's own. Later files are more specific than earlier ones: when two conflict, the later one wins. They describe the project, not the current request; if the user asks for something these files do not cover, use your own judgment.

<project_instructions>
${blocks}
</project_instructions>
`;
}
