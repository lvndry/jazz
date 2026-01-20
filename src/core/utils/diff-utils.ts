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
  options: DiffOptions = {}
): string {
  const { maxLines = 20, isNewFile = false, contextLines = 3 } = options;

  // For new files, just show a creation summary - not the full content
  if (isNewFile || originalContent === "") {
    const lineCount = newContent.split("\n").length;
    return chalk.green(`+ Created file: ${filepath} (${lineCount} lines)`);
  }

  // If content is identical, no diff needed
  if (originalContent === newContent) {
    return "";
  }

  // Generate unified diff using the diff library
  const basename = getBasename(filepath);
  const patch = createPatch(basename, originalContent, newContent, "", "", {
    context: contextLines,
  });

  // Parse and colorize the patch output
  const lines = patch.split("\n");
  const output: string[] = [];
  let changedLinesCount = 0;
  let headersDone = false;

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
        output.push(chalk.dim(`... output truncated (showing first ${maxLines} changes)`));
        break;
      }
      output.push(chalk.green(line));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      changedLinesCount++;
      if (changedLinesCount > maxLines) {
        output.push(chalk.dim(`... output truncated (showing first ${maxLines} changes)`));
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

  return output.join("\n");
}

/**
 * Get the basename of a file path
 */
function getBasename(filepath: string): string {
  const parts = filepath.split("/");
  return parts[parts.length - 1] || filepath;
}
