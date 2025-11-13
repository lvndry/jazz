import { Effect, Layer } from "effect";
import {
  createCdTool,
  createExecuteMkdirTool,
  createExecuteRmTool,
  createExecuteWriteFileTool,
  createFindDirTool,
  createFindPathTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createMkdirTool,
  createPwdTool,
  createReadFileTool,
  createRmTool,
  createStatTool,
  createWriteFileTool,
} from "./fs-tools";
import {
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
import { ToolRegistryTag, type ToolRegistry } from "./tool-registry";
import { createWebSearchTool } from "./web-search-tools";

/**
 * Tool registration module
 */

// Register all tools
export function registerAllTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    // Register Gmail tools
    yield* registerGmailTools();

    // Register other tool categories as needed
    yield* registerFileTools();
    yield* registerShellTools();
    yield* registerGitTools();
    yield* registerSearchTools();
    yield* registerHttpTools();
  });
}

// Register Gmail tools
export function registerGmailTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory("Gmail");

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
    const registerTool = registry.registerForCategory("HTTP");

    const httpRequestTool = createHttpRequestTool();

    yield* registerTool(httpRequestTool);
  });
}

// Register filesystem tools
export function registerFileTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory("File Management");

    const pwd = createPwdTool();
    const ls = createLsTool();
    const cd = createCdTool();
    const grep = createGrepTool();
    const readFile = createReadFileTool();
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

    yield* registerTool(pwd);
    yield* registerTool(ls);
    yield* registerTool(cd);
    yield* registerTool(grep);
    yield* registerTool(readFile);
    yield* registerTool(writeFile);
    yield* registerTool(find);
    yield* registerTool(finddir);
    yield* registerTool(findPath);
    yield* registerTool(stat);
    yield* registerTool(mkdir);
    yield* registerTool(executeMkdir);
    yield* registerTool(rm);
    yield* registerTool(executeRm);
    yield* registerTool(executeWriteFile);
  });
}

// Register shell command execution tools
export function registerShellTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory("Shell Commands");

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
    const registerTool = registry.registerForCategory("Git");

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
  });
}

// Register web search tools
export function registerSearchTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory("Search");

    const webSearchTool = createWebSearchTool();

    yield* registerTool(webSearchTool);
  });
}

// Create a layer that registers all tools
export function createToolRegistrationLayer(): Layer.Layer<never, Error, ToolRegistry> {
  return Layer.effectDiscard(registerAllTools());
}
