/**
 * Git Tools Module
 *
 * Provides organized access to Git operations through a unified namespace.
 * Tools are organized by operation type:
 * - Read operations: Safe, read-only git commands
 * - Write operations: Approval-required commands (return ApprovalToolPair)
 */

// Re-export from individual tool modules
import { createGitAddTools } from "./add";
import { createGitBlameTool } from "./blame";
import { createGitBranchTool } from "./branch";
import { createGitCheckoutTools } from "./checkout";
import { createGitCommitTools } from "./commit";
import { createGitDiffTool } from "./diff";
import { createGitLogTool } from "./log";
import { createGitMergeTools } from "./merge";
import { createGitPullTools } from "./pull";
import { createGitPushTools } from "./push";
import { createGitReflogTool } from "./reflog";
import { createGitRmTools } from "./rm";
import { createGitStatusTool } from "./status";
import { createGitTagListTool, createGitTagTools } from "./tag";

/**
 * Git tools namespace
 *
 * Usage:
 * ```typescript
 * import { git } from "./git";
 *
 * // Create read-only tools
 * const statusTool = git.status();
 * const logTool = git.log();
 *
 * // Create write tools (return { approval, execute } pair)
 * const addTools = git.add();
 * const commitTools = git.commit();
 * ```
 */
export const git = {
  // === Read Operations (safe - no approval needed) ===

  /** Get the current status of the Git repository */
  status: createGitStatusTool,

  /** View commit history */
  log: createGitLogTool,

  /** Show differences between commits, branches, or working tree */
  diff: createGitDiffTool,

  /** List Git branches */
  branch: createGitBranchTool,

  /** Show file annotations (who changed what line) */
  blame: createGitBlameTool,

  /** Show reference log of HEAD updates */
  reflog: createGitReflogTool,

  /** List Git tags */
  tagList: createGitTagListTool,

  // === Write Operations (approval required - return ApprovalToolPair) ===

  /** Stage files for commit (returns { approval, execute }) */
  add: createGitAddTools,

  /** Create a commit with staged changes (returns { approval, execute }) */
  commit: createGitCommitTools,

  /** Push commits to remote repository (returns { approval, execute }) */
  push: createGitPushTools,

  /** Pull changes from remote repository (returns { approval, execute }) */
  pull: createGitPullTools,

  /** Switch branches or restore working tree files (returns { approval, execute }) */
  checkout: createGitCheckoutTools,

  /** Merge branches (returns { approval, execute }) */
  merge: createGitMergeTools,

  /** Remove files from working tree and index (returns { approval, execute }) */
  rm: createGitRmTools,

  /** Create or delete tags (returns { approval, execute }) */
  tag: createGitTagTools,
} as const;

// Export individual tool creators
export {
  createGitAddTools,
  createGitBlameTool,
  createGitBranchTool,
  createGitCheckoutTools,
  createGitCommitTools,
  createGitDiffTool,
  createGitLogTool,
  createGitMergeTools,
  createGitPullTools,
  createGitPushTools,
  createGitReflogTool,
  createGitRmTools,
  createGitStatusTool,
  createGitTagListTool,
  createGitTagTools,
};

// Export utility types and functions
export { DEFAULT_GIT_TIMEOUT, resolveGitWorkingDirectory, runGitCommand } from "./utils";
export type { GitCommandResult } from "./utils";
