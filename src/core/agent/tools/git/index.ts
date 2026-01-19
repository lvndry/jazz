/**
 * Git Tools Module
 *
 * Provides organized access to Git operations through a unified namespace.
 * Tools are organized by operation type:
 * - Read operations: Safe, read-only git commands
 * - Write operations: Approval-required destructive commands
 */

// Re-export from individual tool modules
import { createExecuteGitAddTool, createGitAddTool } from "./add";
import { createGitBlameTool } from "./blame";
import { createGitBranchTool } from "./branch";
import { createExecuteGitCheckoutTool, createGitCheckoutTool } from "./checkout";
import { createExecuteGitCommitTool, createGitCommitTool } from "./commit";
import { createGitDiffTool } from "./diff";
import { createGitLogTool } from "./log";
import { createExecuteGitMergeTool, createGitMergeTool } from "./merge";
import { createExecuteGitPullTool, createGitPullTool } from "./pull";
import { createExecuteGitPushTool, createGitPushTool } from "./push";
import { createGitReflogTool } from "./reflog";
import { createExecuteGitRmTool, createGitRmTool } from "./rm";
import { createGitStatusTool } from "./status";
import { createExecuteGitTagTool, createGitTagTool } from "./tag";

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
 * // Create write tools (require approval)
 * const addTool = git.add();
 * const commitTool = git.commit();
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

  /** List tags */
  tag: createGitTagTool,

  // === Write Operations (approval required) ===

  /** Stage files for commit */
  add: createGitAddTool,

  /** Create a commit with staged changes */
  commit: createGitCommitTool,

  /** Push commits to remote repository */
  push: createGitPushTool,

  /** Pull changes from remote repository */
  pull: createGitPullTool,

  /** Switch branches or restore working tree files */
  checkout: createGitCheckoutTool,

  /** Merge branches */
  merge: createGitMergeTool,

  /** Remove files from working tree and index */
  rm: createGitRmTool,

  // === Execute Tools (internal - called after approval) ===

  /** Execute git add after approval */
  executeAdd: createExecuteGitAddTool,

  /** Execute git commit after approval */
  executeCommit: createExecuteGitCommitTool,

  /** Execute git push after approval */
  executePush: createExecuteGitPushTool,

  /** Execute git pull after approval */
  executePull: createExecuteGitPullTool,

  /** Execute git checkout after approval */
  executeCheckout: createExecuteGitCheckoutTool,

  /** Execute git merge after approval */
  executeMerge: createExecuteGitMergeTool,

  /** Execute git tag after approval */
  executeTag: createExecuteGitTagTool,

  /** Execute git rm after approval */
  executeRm: createExecuteGitRmTool,
} as const;

// Export individual tool creators for backwards compatibility
export {
  createExecuteGitAddTool,
  createExecuteGitCheckoutTool,
  createExecuteGitCommitTool,
  createExecuteGitMergeTool,
  createExecuteGitPullTool,
  createExecuteGitPushTool,
  createExecuteGitRmTool,
  createExecuteGitTagTool,
  createGitAddTool,
  createGitBlameTool,
  createGitBranchTool,
  createGitCheckoutTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitLogTool,
  createGitMergeTool,
  createGitPullTool,
  createGitPushTool,
  createGitReflogTool,
  createGitRmTool,
  createGitStatusTool,
  createGitTagTool
};

// Export utility types and functions
  export { DEFAULT_GIT_TIMEOUT, resolveGitWorkingDirectory, runGitCommand } from "./utils";
  export type { GitCommandResult } from "./utils";

