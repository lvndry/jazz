import chalk from "chalk";
import { createPatch } from "diff";

/**
 * Configuration for diff generation
 */
export interface DiffOptions {
  /** Maximum number of changed lines to display (default: 20) */
  maxLines?: number;
  /** Whether this is a new file (skip full diff, just show summary) */
  isNewFile?: boolean;
  /** Context lines around changes (default: 3) */
  contextLines?: number;
  /** Emit a real +patch for a new file instead of the one-line creation summary. */
  fullPatch?: boolean;
}

/**
 * Generate a colored git-style diff between two content strings
 *
 * Uses the battle-tested `diff` library (same algorithm as git).
 *
 * @param originalContent - The original file content (empty string for new files)
 * @param newContent - The new file content
 * @param filepath - The file path for the diff header
 * @param options - Configuration options
 * @returns Formatted, colored diff string for terminal display
 */
export function generateDiff(
  originalContent: string,
  newContent: string,
  filepath: string,
  options: DiffOptions = {},
): string {
  return generateDiffWithMetadata(originalContent, newContent, filepath, options).diff;
}

/**
 * The most recent patch, keyed by the exact inputs that produced it.
 *
 * One file mutation renders its patch two or three times: `write_file` and
 * `edit_file` each build a full patch for the approval preview, then a capped
 * one for terminal output after the write, then a full one again when the
 * result needs a Ctrl+O expansion. The inputs are identical every time, and
 * `createPatch` is a Myers diff — on a file whose every line changed it is
 * the most expensive thing on the approval path by two orders of magnitude,
 * so paying it once per render was paying it two or three times per edit.
 *
 * Deliberately one entry: the calls that matter are consecutive on the same
 * content, so a single slot catches them, and nothing accumulates. Concurrent
 * mutations of different files simply miss, which costs only what it cost
 * before. `PATCH_CACHE_MAX_CHARS` keeps a very large pair of file versions
 * from being held alive until the next edit.
 */
let lastPatch:
  | {
      readonly basename: string;
      readonly originalContent: string;
      readonly newContent: string;
      readonly contextLines: number;
      readonly patch: string;
    }
  | undefined;

/** Combined size of the two file versions above which the patch is not retained. */
const PATCH_CACHE_MAX_CHARS = 8_000_000;

function patchFor(
  basename: string,
  originalContent: string,
  newContent: string,
  contextLines: number,
): string {
  if (
    lastPatch !== undefined &&
    lastPatch.contextLines === contextLines &&
    lastPatch.basename === basename &&
    lastPatch.originalContent === originalContent &&
    lastPatch.newContent === newContent
  ) {
    return lastPatch.patch;
  }

  const patch = createPatch(basename, originalContent, newContent, "", "", {
    context: contextLines,
  });

  lastPatch =
    originalContent.length + newContent.length > PATCH_CACHE_MAX_CHARS
      ? undefined
      : { basename, originalContent, newContent, contextLines, patch };

  return patch;
}

export function generateDiffWithMetadata(
  originalContent: string,
  newContent: string,
  filepath: string,
  options: DiffOptions = {},
): { diff: string; wasTruncated: boolean } {
  const { maxLines = 20, isNewFile = false, contextLines = 3, fullPatch = false } = options;

  // For new files, just show a creation summary - not the full content
  if ((isNewFile || originalContent === "") && fullPatch !== true) {
    const lineCount = newContent.split("\n").length;
    return {
      diff: chalk.green(`+ Created file: ${filepath} (${lineCount} lines)`),
      wasTruncated: false,
    };
  }

  // If content is identical, no diff needed
  if (originalContent === newContent) {
    return { diff: "", wasTruncated: false };
  }

  // Generate unified diff using the diff library
  const basename = getBasename(filepath);
  const patch = patchFor(basename, originalContent, newContent, contextLines);

  // Parse and colorize the patch output
  const lines = patch.split("\n");
  const output: string[] = [];
  let changedLinesCount = 0;
  let headersDone = false;
  let wasTruncated = false;

  for (const line of lines) {
    // Handle file headers (first few lines of patch)
    if (!headersDone) {
      if (line.startsWith("Index:") || line.startsWith("===")) {
        continue; // Skip these meta lines
      }
      if (line.startsWith("---")) {
        output.push(chalk.bold.white(`--- a/${basename}`));
        continue;
      }
      if (line.startsWith("+++")) {
        output.push(chalk.bold.white(`+++ b/${basename}`));
        headersDone = true;
        continue;
      }
    }

    // Check if we've exceeded the max lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changedLinesCount++;
      if (changedLinesCount > maxLines) {
        wasTruncated = true;
        output.push(
          chalk.dim(
            `... output truncated (showing first ${maxLines} changes, press Ctrl+O to expand)`,
          ),
        );
        break;
      }
      output.push(chalk.green(line));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      changedLinesCount++;
      if (changedLinesCount > maxLines) {
        wasTruncated = true;
        output.push(
          chalk.dim(
            `... output truncated (showing first ${maxLines} changes, press Ctrl+O to expand)`,
          ),
        );
        break;
      }
      output.push(chalk.red(line));
    } else if (line.startsWith("@@")) {
      output.push(chalk.cyan(line));
    } else if (line.startsWith(" ")) {
      output.push(chalk.dim(line));
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" - show dimmed
      output.push(chalk.dim(line));
    }
  }

  return { diff: output.join("\n"), wasTruncated };
}

/**
 * Get the basename of a file path
 */
function getBasename(filepath: string): string {
  const parts = filepath.split("/");
  return parts[parts.length - 1] || filepath;
}
