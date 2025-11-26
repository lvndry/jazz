import { Effect, Layer } from "effect";
import type { ToolRegistry } from "../../interfaces/tool-registry";
import { ToolRegistryTag } from "../../interfaces/tool-registry";
import type { ToolCategory } from "../../types";
import {
  createCdTool,
  createEditFileTool,
  createExecuteEditFileTool,
  createExecuteMkdirTool,
  createExecuteRmTool,
  createExecuteWriteFileTool,
  createFindDirTool,
  createFindPathTool,
  createFindTool,
  createGrepTool,
  createHeadTool,
  createLsTool,
  createMkdirTool,
  createPwdTool,
  createReadFileTool,
  createRmTool,
  createStatTool,
  createTailTool,
  createWriteFileTool,
} from "./fs-tools";
import {
  createExecuteGitAddTool,
  createExecuteGitCheckoutTool,
  createExecuteGitCommitTool,
  createExecuteGitPullTool,
  createExecuteGitPushTool,
  createGitAddTool,
  createGitBranchTool,
  createGitCheckoutTool,
  createGitCommitTool,
  createGitDiffTool,
  createGitLogTool,
  createGitPullTool,
  createGitPushTool,
  createGitStatusTool,
} from "./git-tools";
import {
  createAddLabelsToEmailTool,
  createBatchModifyEmailsTool,
  createCreateLabelTool,
  createDeleteEmailTool,
  createDeleteLabelTool,
  createExecuteDeleteEmailTool,
  createExecuteDeleteLabelTool,
  createExecuteTrashEmailTool,
  createGetEmailTool,
  createListEmailsTool,
  createListLabelsTool,
  createRemoveLabelsFromEmailTool,
  createSearchEmailsTool,
  createSendEmailTool,
  createTrashEmailTool,
  createUpdateLabelTool,
} from "./gmail-tools";
import { createHttpRequestTool } from "./http-tools";
import { createExecuteCommandApprovedTool, createExecuteCommandTool } from "./shell-tools";
import { createWebSearchTool } from "./web-search-tools";

/**
 * Tool registration module
 */

// Register all tools
export function registerAllTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    yield* registerGmailTools();
    yield* registerFileTools();
    yield* registerShellTools();
    yield* registerGitTools();
    yield* registerSearchTools();
    yield* registerHttpTools();
  });
}

export const GMAIL_CATEGORY: ToolCategory = { id: "gmail", displayName: "Gmail" };
export const HTTP_CATEGORY: ToolCategory = { id: "http", displayName: "HTTP" };
export const FILE_MANAGEMENT_CATEGORY: ToolCategory = {
  id: "file_management",
  displayName: "File Management",
};
export const SHELL_COMMANDS_CATEGORY: ToolCategory = {
  id: "shell_commands",
  displayName: "Shell Commands",
};
export const GIT_CATEGORY: ToolCategory = { id: "git", displayName: "Git" };
export const WEB_SEARCH_CATEGORY: ToolCategory = { id: "search", displayName: "Search" };

/**
 * All available tool categories
 */
export const ALL_CATEGORIES: readonly ToolCategory[] = [
  FILE_MANAGEMENT_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  GIT_CATEGORY,
  HTTP_CATEGORY,
  WEB_SEARCH_CATEGORY,
  GMAIL_CATEGORY,
] as const;

/**
 * Create mappings between category display names and IDs
 */
export function createCategoryMappings(): {
  displayNameToId: Map<string, string>;
  idToDisplayName: Map<string, string>;
} {
  const displayNameToId = new Map<string, string>();
  const idToDisplayName = new Map<string, string>();

  for (const category of ALL_CATEGORIES) {
    displayNameToId.set(category.displayName, category.id);
    idToDisplayName.set(category.id, category.displayName);
  }

  return {
    displayNameToId,
    idToDisplayName,
  };
}

// Register Gmail tools
export function registerGmailTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(GMAIL_CATEGORY);

    // Create Gmail tools
    const listEmailsTool = createListEmailsTool();
    const getEmailTool = createGetEmailTool();
    const searchEmailsTool = createSearchEmailsTool();
    const sendEmailTool = createSendEmailTool();
    const trashEmailTool = createTrashEmailTool();
    const deleteEmailTool = createDeleteEmailTool();

    // Create execution tools
    const executeTrashEmailTool = createExecuteTrashEmailTool();
    const executeDeleteEmailTool = createExecuteDeleteEmailTool();
    const executeDeleteLabelTool = createExecuteDeleteLabelTool();

    // Create Gmail label management tools
    const listLabelsTool = createListLabelsTool();
    const createLabelTool = createCreateLabelTool();
    const updateLabelTool = createUpdateLabelTool();
    const deleteLabelTool = createDeleteLabelTool();

    // Create Gmail email organization tools
    const addLabelsToEmailTool = createAddLabelsToEmailTool();
    const removeLabelsFromEmailTool = createRemoveLabelsFromEmailTool();
    const batchModifyEmailsTool = createBatchModifyEmailsTool();

    // Register Gmail tools
    yield* registerTool(listEmailsTool);
    yield* registerTool(getEmailTool);
    yield* registerTool(searchEmailsTool);
    yield* registerTool(sendEmailTool);
    yield* registerTool(trashEmailTool);
    yield* registerTool(deleteEmailTool);

    // Register execution tools
    yield* registerTool(executeTrashEmailTool);
    yield* registerTool(executeDeleteEmailTool);
    yield* registerTool(executeDeleteLabelTool);

    // Register Gmail label management tools
    yield* registerTool(listLabelsTool);
    yield* registerTool(createLabelTool);
    yield* registerTool(updateLabelTool);
    yield* registerTool(deleteLabelTool);

    // Register Gmail email organization tools
    yield* registerTool(addLabelsToEmailTool);
    yield* registerTool(removeLabelsFromEmailTool);
    yield* registerTool(batchModifyEmailsTool);
  });
}

// Register HTTP tools
export function registerHttpTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(HTTP_CATEGORY);

    const httpRequestTool = createHttpRequestTool();

    yield* registerTool(httpRequestTool);
  });
}

// Register filesystem tools
export function registerFileTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(FILE_MANAGEMENT_CATEGORY);

    const pwd = createPwdTool();
    const ls = createLsTool();
    const cd = createCdTool();
    const grep = createGrepTool();
    const readFile = createReadFileTool();
    const head = createHeadTool();
    const tail = createTailTool();
    const find = createFindTool();
    const finddir = createFindDirTool();
    const findPath = createFindPathTool();
    const stat = createStatTool();
    const mkdir = createMkdirTool();
    const executeMkdir = createExecuteMkdirTool();
    const rm = createRmTool();
    const executeRm = createExecuteRmTool();
    const writeFile = createWriteFileTool();
    const executeWriteFile = createExecuteWriteFileTool();
    const editFile = createEditFileTool();
    const executeEditFile = createExecuteEditFileTool();

    yield* registerTool(pwd);
    yield* registerTool(ls);
    yield* registerTool(cd);
    yield* registerTool(grep);
    yield* registerTool(readFile);
    yield* registerTool(head);
    yield* registerTool(tail);
    yield* registerTool(writeFile);
    yield* registerTool(editFile);
    yield* registerTool(find);
    yield* registerTool(finddir);
    yield* registerTool(findPath);
    yield* registerTool(stat);
    yield* registerTool(mkdir);
    yield* registerTool(executeMkdir);
    yield* registerTool(rm);
    yield* registerTool(executeRm);
    yield* registerTool(executeWriteFile);
    yield* registerTool(executeEditFile);
  });
}

// Register shell command execution tools
export function registerShellTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SHELL_COMMANDS_CATEGORY);

    const executeCommandTool = createExecuteCommandTool();
    const executeCommandApprovedTool = createExecuteCommandApprovedTool();

    yield* registerTool(executeCommandTool);
    yield* registerTool(executeCommandApprovedTool);
  });
}

// Register Git tools
export function registerGitTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(GIT_CATEGORY);

    // Safe Git operations (no approval needed)
    const gitStatusTool = createGitStatusTool();
    const gitLogTool = createGitLogTool();
    const gitDiffTool = createGitDiffTool();
    const gitBranchTool = createGitBranchTool();

    // Potentially destructive operations (approval required)
    const gitAddTool = createGitAddTool();
    const gitCommitTool = createGitCommitTool();
    const gitPushTool = createGitPushTool();
    const gitPullTool = createGitPullTool();
    const gitCheckoutTool = createGitCheckoutTool();

    // Internal execution tools (called after approval)
    const executeGitAddTool = createExecuteGitAddTool();
    const executeGitCommitTool = createExecuteGitCommitTool();
    const executeGitPushTool = createExecuteGitPushTool();
    const executeGitPullTool = createExecuteGitPullTool();
    const executeGitCheckoutTool = createExecuteGitCheckoutTool();

    // Register safe tools
    yield* registerTool(gitStatusTool);
    yield* registerTool(gitLogTool);
    yield* registerTool(gitDiffTool);
    yield* registerTool(gitBranchTool);

    // Register approval-required tools
    yield* registerTool(gitAddTool);
    yield* registerTool(gitCommitTool);
    yield* registerTool(gitPushTool);
    yield* registerTool(gitPullTool);
    yield* registerTool(gitCheckoutTool);

    // Register internal execution tools
    yield* registerTool(executeGitAddTool);
    yield* registerTool(executeGitCommitTool);
    yield* registerTool(executeGitPushTool);
    yield* registerTool(executeGitPullTool);
    yield* registerTool(executeGitCheckoutTool);
  });
}

// Register web search tools
export function registerSearchTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(WEB_SEARCH_CATEGORY);

    const webSearchTool = createWebSearchTool();

    yield* registerTool(webSearchTool);
  });
}

// Create a layer that registers all tools
export function createToolRegistrationLayer(): Layer.Layer<never, Error, ToolRegistry> {
  return Layer.effectDiscard(registerAllTools());
}
