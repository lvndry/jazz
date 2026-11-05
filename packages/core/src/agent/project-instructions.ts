import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abbreviateHomePath } from "@/core/utils/storage";

/**
 * AGENTS.md support — the cross-tool convention for project instructions
 * (https://agents.md). A repository drops an `AGENTS.md` at its root (and
 * optionally in subdirectories) describing build commands, conventions, and
 * house rules; every agent that reads the convention picks them up.
 */

export interface ProjectInstructionFile {
  readonly path: string;
  readonly content: string;
  /** Bytes cut from the end of the file to fit its chain budget; absent when the file is whole. */
  readonly truncatedBytes?: number;
}

export type InstructionChain = "global" | "project";

export type InstructionFileStatus = "included" | "truncated" | "omitted" | "skipped";

export interface InstructionFileReport {
  readonly path: string;
  readonly chain: InstructionChain;
  readonly status: InstructionFileStatus;
  readonly originalBytes: number;
  readonly includedBytes: number;
  readonly reason?: string;
}

export interface ProjectInstructionOmission {
  readonly path: string;
  readonly bytes: number;
}

export interface ProjectInstructionDiscovery {
  readonly files: readonly ProjectInstructionFile[];
  readonly omissions: readonly ProjectInstructionOmission[];
  readonly reports: readonly InstructionFileReport[];
}

const INSTRUCTION_FILE_NAME = "AGENTS.md";

/**
 * Byte budget for the user's global `~/.agents/AGENTS.md`. Equal to the former
 * per-file cap so an existing global file is never cut more than before.
 * Applied independently of the project chain, so a large project can never
 * evict the user's personal defaults.
 */
export const GLOBAL_INSTRUCTIONS_BUDGET_BYTES = 32 * 1024;

/**
 * Byte budget for the whole project chain (repository root down to the working
 * directory). Equal to the former per-file cap, so a repository with one
 * AGENTS.md behaves as before while a long ancestor chain can no longer grow
 * the system prompt without bound. Typical files are 1-8 KB.
 */
export const PROJECT_INSTRUCTIONS_BUDGET_BYTES = 32 * 1024;

/**
 * Upper bound on how far the ancestor walk climbs when no repository root is
 * found. Guards against pathological paths and network mounts.
 */
const MAX_ANCESTOR_DEPTH = 32;

const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_PATTERN = 0x80;

interface CandidateFile {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
}

interface ReadOutcome {
  readonly candidate?: CandidateFile;
  readonly report?: InstructionFileReport;
}

function isWithin(parentDirectory: string, childPath: string): boolean {
  const relative = path.relative(parentDirectory, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function skipped(filePath: string, chain: InstructionChain, reason: string): ReadOutcome {
  return {
    report: {
      path: filePath,
      chain,
      status: "skipped",
      originalBytes: 0,
      includedBytes: 0,
      reason,
    },
  };
}

/**
 * Reads one candidate. Missing and empty files are silently absent; symlinks
 * resolving outside `allowedRoot` and unreadable files are reported as skipped.
 */
function readCandidate(
  filePath: string,
  chain: InstructionChain,
  allowedRoot: string,
): ReadOutcome {
  let linkStats: fs.Stats;
  try {
    linkStats = fs.lstatSync(filePath);
  } catch {
    return {};
  }

  try {
    if (linkStats.isSymbolicLink()) {
      const resolved = fs.realpathSync(filePath);
      if (!isWithin(fs.realpathSync(allowedRoot), resolved)) {
        return skipped(filePath, chain, "symlink resolves outside the allowed tree");
      }
    }

    if (!fs.statSync(filePath).isFile()) {
      return {};
    }

    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (content.length === 0) {
      return {};
    }
    return { candidate: { path: filePath, content, bytes: Buffer.byteLength(content, "utf-8") } };
  } catch (error) {
    return skipped(
      filePath,
      chain,
      `unreadable: ${error instanceof Error ? error.message : "error"}`,
    );
  }
}

/** Cuts `content` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateToBytes(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, "utf-8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && end < buffer.length) {
    const byte = buffer[end];
    if (byte === undefined || (byte & UTF8_CONTINUATION_MASK) !== UTF8_CONTINUATION_PATTERN) {
      break;
    }
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf-8");
}

interface BudgetResult {
  readonly files: readonly ProjectInstructionFile[];
  readonly omissions: readonly ProjectInstructionOmission[];
  readonly reports: readonly InstructionFileReport[];
}

/**
 * Spends `budgetBytes` on `candidates` (outermost first) starting from the
 * nearest. The first file that does not fit keeps its beginning; everything
 * broader than it is omitted. Output keeps the outermost-first order.
 */
function applyBudget(
  candidates: readonly CandidateFile[],
  chain: InstructionChain,
  budgetBytes: number,
): BudgetResult {
  let remaining = budgetBytes;
  const files: ProjectInstructionFile[] = [];
  const omissions: ProjectInstructionOmission[] = [];
  const reports: InstructionFileReport[] = [];

  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }

    if (candidate.bytes <= remaining) {
      remaining -= candidate.bytes;
      files.unshift({ path: candidate.path, content: candidate.content });
      reports.unshift({
        path: candidate.path,
        chain,
        status: "included",
        originalBytes: candidate.bytes,
        includedBytes: candidate.bytes,
      });
      continue;
    }

    const kept = remaining > 0 ? truncateToBytes(candidate.content, remaining).trimEnd() : "";
    const keptBytes = Buffer.byteLength(kept, "utf-8");
    remaining = 0;

    if (keptBytes === 0) {
      omissions.unshift({ path: candidate.path, bytes: candidate.bytes });
      reports.unshift({
        path: candidate.path,
        chain,
        status: "omitted",
        originalBytes: candidate.bytes,
        includedBytes: 0,
        reason: `chain budget of ${String(budgetBytes)} bytes exhausted`,
      });
      continue;
    }

    files.unshift({
      path: candidate.path,
      content: kept,
      truncatedBytes: candidate.bytes - keptBytes,
    });
    reports.unshift({
      path: candidate.path,
      chain,
      status: "truncated",
      originalBytes: candidate.bytes,
      includedBytes: keptBytes,
      reason: `chain budget of ${String(budgetBytes)} bytes exceeded`,
    });
  }

  return { files, omissions, reports };
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
 * Two chains, each with its own byte budget: the global `~/.agents/AGENTS.md`
 * (the shared location Jazz already reads cross-tool skills from) and the
 * project chain from the repository root down to `startDir`. Within the project
 * chain the nearest file is kept first, so an over-budget chain loses its
 * broadest files, never the most specific one.
 *
 * `files` is outermost-first, global first, so the nearest file lands last in
 * the prompt: when a nested `AGENTS.md` contradicts one further up, the more
 * specific instruction is the one the model reads most recently. The result is
 * a pure function of the file contents, which keeps the cached prompt prefix
 * stable across turns.
 */
export function discoverProjectInstructions(
  startDir: string,
  homeDirectory: string = os.homedir(),
): ProjectInstructionDiscovery {
  const reports: InstructionFileReport[] = [];
  const globalCandidates: CandidateFile[] = [];
  const projectCandidates: CandidateFile[] = [];
  const seenPaths = new Set<string>();

  if (homeDirectory && homeDirectory.trim().length > 0) {
    const globalPath = path.join(homeDirectory, ".agents", INSTRUCTION_FILE_NAME);
    seenPaths.add(globalPath);
    const outcome = readCandidate(globalPath, "global", homeDirectory);
    if (outcome.report) reports.push(outcome.report);
    if (outcome.candidate) globalCandidates.push(outcome.candidate);
  }

  const directories = collectDirectories(startDir, homeDirectory);
  const chainRoot = directories[0];
  for (const directory of directories) {
    const candidatePath = path.join(directory, INSTRUCTION_FILE_NAME);
    if (seenPaths.has(candidatePath)) {
      continue;
    }
    seenPaths.add(candidatePath);

    const outcome = readCandidate(candidatePath, "project", chainRoot ?? directory);
    if (outcome.report) reports.push(outcome.report);
    if (outcome.candidate) projectCandidates.push(outcome.candidate);
  }

  const globalResult = applyBudget(globalCandidates, "global", GLOBAL_INSTRUCTIONS_BUDGET_BYTES);
  const projectResult = applyBudget(
    projectCandidates,
    "project",
    PROJECT_INSTRUCTIONS_BUDGET_BYTES,
  );

  return {
    files: [...globalResult.files, ...projectResult.files],
    omissions: [...globalResult.omissions, ...projectResult.omissions],
    reports: [...reports, ...globalResult.reports, ...projectResult.reports],
  };
}

/**
 * Renders discovered instruction files as a system-prompt section.
 *
 * A truncated file ends with a marker and omitted files are listed after the
 * files, each with byte counts, so the model can tell the user which
 * instruction files were too large. Returns an empty string when there is
 * nothing to render, so callers can concatenate unconditionally.
 */
export function renderProjectInstructions(
  files: readonly ProjectInstructionFile[],
  homeDirectory: string = os.homedir(),
  omissions: readonly ProjectInstructionOmission[] = [],
): string {
  if (files.length === 0 && omissions.length === 0) return "";

  const displayPath = (filePath: string): string => abbreviateHomePath(filePath, homeDirectory);

  const blocks = files
    .map((file) => {
      const marker =
        file.truncatedBytes === undefined
          ? ""
          : `\n\n[This file was cut: its last ${String(file.truncatedBytes)} bytes did not fit the instruction size budget. Tell the user that ${displayPath(file.path)} is too large and should be shortened.]`;
      return `<file path="${displayPath(file.path)}">\n${file.content}${marker}\n</file>`;
    })
    .join("\n\n");

  const omittedBlock =
    omissions.length === 0
      ? ""
      : `\n\n<omitted_files>\nThese instruction files did not fit the size budget and are not shown. Tell the user they were left out so they can shorten them:\n${omissions
          .map((omission) => `- ${displayPath(omission.path)} (${String(omission.bytes)} bytes)`)
          .join("\n")}\n</omitted_files>`;

  return `
## Project instructions

The AGENTS.md files below were found in and above the current working directory. They are instructions from the people who own this project — follow them as you would the user's own. Later files are more specific than earlier ones: when two conflict, the later one wins. They describe the project, not the current request; if the user asks for something these files do not cover, use your own judgment.

<project_instructions>
${blocks}${omittedBlock}
</project_instructions>
`;
}
