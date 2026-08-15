import { Effect, Layer } from "effect";
import type { ToolRegistry } from "@/core/interfaces/tool-registry";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import { createContextInfoTool, createGetTimeTool } from "./context-tools";
import { fs } from "./fs";
import { git } from "./git";
import { createHttpRequestTool } from "./http-tools";
import { createManageMemoryTool, createViewMemoryTool } from "./memory-tools";
import {
  createAddReminderTool,
  createCancelReminderTool,
  createListRemindersTool,
} from "./reminder-tools";
import { createShellCommandTools } from "./shell-tools";
import { createSkillTools } from "./skill-tools";
import { createSubagentTools } from "./subagent-tools";
import { createListTodosTool, createManageTodosTool } from "./todo-tools";
import {
  CONTEXT_CATEGORY,
  FILE_MANAGEMENT_CATEGORY,
  GIT_CATEGORY,
  HTTP_CATEGORY,
  MEMORY_CATEGORY,
  REMINDER_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  SKILLS_CATEGORY,
  SUBAGENT_CATEGORY,
  TODO_CATEGORY,
  USER_INTERACTION_CATEGORY,
  WEB_APP_CATEGORY,
  WEB_FETCH_CATEGORY,
  WEB_SEARCH_CATEGORY,
} from "./tool-categories";
import { userInteractionTools } from "./user-interaction-tools";
import { createWebAppTool } from "./web-app-tools";
import { createWebFetchTool } from "./web-fetch-tools";
import { createWebSearchTool } from "./web-search-tools";

/**
 * Register every globally-available builtin tool.
 *
 * MCP tools are not registered here — they connect on first use via
 * `registerMCPToolsForAgent` so a hung server cannot stall CLI startup.
 * Skills are registered per-agent via `registerSkillSystemTools`.
 */
export function registerAllTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    yield* registerFileTools();
    yield* registerShellTools();
    yield* registerGitTools();
    yield* registerSearchTools();
    yield* registerHttpTools();
    yield* registerTodoTools();
    yield* registerMemoryTools();
    yield* registerReminderTools();
    yield* registerContextTools();
    yield* registerSubagentTools();
    yield* registerUserInteractionTools();
    yield* registerWebAppTools();
  });
}

export function registerHttpTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(HTTP_CATEGORY);

    const httpRequestTool = createHttpRequestTool();

    yield* registerTool(httpRequestTool);
  });
}

export function registerFileTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(FILE_MANAGEMENT_CATEGORY);

    // Navigation tools
    yield* registerTool(fs.pwd());
    yield* registerTool(fs.ls());
    yield* registerTool(fs.cd());
    yield* registerTool(fs.stat());

    // Read tools
    yield* registerTool(fs.read());
    yield* registerTool(fs.readPdf());
    yield* registerTool(fs.pdfPageCount());
    yield* registerTool(fs.head());
    yield* registerTool(fs.tail());

    // Search tools
    yield* registerTool(fs.grep());
    yield* registerTool(fs.find());

    // Write tools (approval required) - each returns { approval, execute }
    const writeTools = fs.write();
    yield* registerTool(writeTools.approval);
    yield* registerTool(writeTools.execute);

    const editTools = fs.edit();
    yield* registerTool(editTools.approval);
    yield* registerTool(editTools.execute);

    const mkdirTools = fs.mkdir();
    yield* registerTool(mkdirTools.approval);
    yield* registerTool(mkdirTools.execute);

    const rmTools = fs.rm();
    yield* registerTool(rmTools.approval);
    yield* registerTool(rmTools.execute);

    const mvTools = fs.mv();
    yield* registerTool(mvTools.approval);
    yield* registerTool(mvTools.execute);

    const cpTools = fs.cp();
    yield* registerTool(cpTools.approval);
    yield* registerTool(cpTools.execute);
  });
}

export function registerShellTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SHELL_COMMANDS_CATEGORY);

    const shellTools = createShellCommandTools();
    yield* registerTool(shellTools.approval);
    yield* registerTool(shellTools.execute);
  });
}

export function registerGitTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(GIT_CATEGORY);

    // Safe Git operations (no approval needed)
    yield* registerTool(git.status());
    yield* registerTool(git.log());
    yield* registerTool(git.diff());
    yield* registerTool(git.branch());
    yield* registerTool(git.blame());
    yield* registerTool(git.reflog());
    yield* registerTool(git.tagList());

    // Approval-required operations - each returns { approval, execute }
    const addTools = git.add();
    yield* registerTool(addTools.approval);
    yield* registerTool(addTools.execute);

    const commitTools = git.commit();
    yield* registerTool(commitTools.approval);
    yield* registerTool(commitTools.execute);

    const pushTools = git.push();
    yield* registerTool(pushTools.approval);
    yield* registerTool(pushTools.execute);

    const pullTools = git.pull();
    yield* registerTool(pullTools.approval);
    yield* registerTool(pullTools.execute);

    const checkoutTools = git.checkout();
    yield* registerTool(checkoutTools.approval);
    yield* registerTool(checkoutTools.execute);

    const mergeTools = git.merge();
    yield* registerTool(mergeTools.approval);
    yield* registerTool(mergeTools.execute);

    const rmTools = git.rm();
    yield* registerTool(rmTools.approval);
    yield* registerTool(rmTools.execute);

    const tagTools = git.tag();
    yield* registerTool(tagTools.approval);
    yield* registerTool(tagTools.execute);
  });
}

export function registerSearchTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerSearchTool = registry.registerForCategory(WEB_SEARCH_CATEGORY);
    const registerFetchTool = registry.registerForCategory(WEB_FETCH_CATEGORY);

    yield* registerSearchTool(createWebSearchTool());
    yield* registerFetchTool(createWebFetchTool());
  });
}

export function registerSkillSystemTools(
  skillNames: readonly string[],
): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SKILLS_CATEGORY);

    for (const tool of createSkillTools(skillNames)) {
      yield* registerTool(tool);
    }
  });
}

export function registerTodoTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(TODO_CATEGORY);

    yield* registerTool(createManageTodosTool());
    yield* registerTool(createListTodosTool());
  });
}

export function registerMemoryTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(MEMORY_CATEGORY);

    yield* registerTool(createViewMemoryTool());
    yield* registerTool(createManageMemoryTool());
  });
}

export function registerReminderTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(REMINDER_CATEGORY);

    yield* registerTool(createAddReminderTool());
    yield* registerTool(createListRemindersTool());
    yield* registerTool(createCancelReminderTool());
  });
}

export function registerContextTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(CONTEXT_CATEGORY);

    yield* registerTool(createContextInfoTool());
    yield* registerTool(createGetTimeTool());
  });
}

export function registerWebAppTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(WEB_APP_CATEGORY);

    yield* registerTool(createWebAppTool());
  });
}

export function registerSubagentTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(SUBAGENT_CATEGORY);

    for (const tool of createSubagentTools()) {
      yield* registerTool(tool);
    }
  });
}

export function registerUserInteractionTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(USER_INTERACTION_CATEGORY);

    for (const tool of userInteractionTools) {
      yield* registerTool(tool);
    }
  });
}

/**
 * Layer that registers all globally-available builtin tools.
 *
 * Requires ToolRegistry. MCP and skills are registered per-agent, not here.
 */
export function createToolRegistrationLayer(): Layer.Layer<never, Error, ToolRegistry> {
  return Layer.effectDiscard(registerAllTools());
}
