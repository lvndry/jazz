/**
 * Wires every builtin tool module into the tool registry under its category.
 * MCP and skill tools are registered elsewhere (per-server / per-agent), so
 * `registerAllTools` covers only what's globally available at startup.
 */

import { Effect, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { ToolRegistry } from "@/core/interfaces/tool-registry";
import { ToolRegistryTag } from "@/core/interfaces/tool-registry";
import { createContextInfoTool, createGetTimeTool } from "./context-tools";
import { fs } from "./fs";
import { createHttpRequestTool } from "./http-tools";
import { createJobQueueTools } from "./job-queue-tools";
import { createManageMemoryTool, createViewMemoryTool } from "./memory-tools";
import { createPdfTool } from "./pdf-tools";
import { createAskPeerTool } from "./peer-tools";
import { createPerceptionTools } from "./perception-tools";
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
  HTTP_CATEGORY,
  JOB_QUEUE_CATEGORY,
  MEMORY_CATEGORY,
  PEERS_CATEGORY,
  PERCEPTION_CATEGORY,
  REMINDER_CATEGORY,
  SHELL_COMMANDS_CATEGORY,
  SKILLS_CATEGORY,
  SUBAGENT_CATEGORY,
  TODO_CATEGORY,
  USER_INTERACTION_CATEGORY,
  WAKE_TRIGGER_CATEGORY,
  WEB_APP_CATEGORY,
  WEB_FETCH_CATEGORY,
  WEB_SEARCH_CATEGORY,
  WORKSPACE_CATEGORY,
} from "./tool-categories";
import { userInteractionTools } from "./user-interaction-tools";
import {
  createCancelTriggerTool,
  createListTriggersTool,
  createRegisterTriggerTool,
} from "./wake-trigger-tools";
import { createWebAppTool } from "./web-app-tools";
import { createWebFetchTool } from "./web-fetch-tools";
import { createWebSearchTool } from "./web-search-tools";
import { createUpdateWorkStateTool } from "./work-state-tools";
import { createManageWorkspaceTool, createViewWorkspaceTool } from "./workspace-tools";

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
    yield* registerSearchTools();
    yield* registerHttpTools();
    yield* registerTodoTools();
    yield* registerMemoryTools();
    yield* registerWorkspaceTools();
    yield* registerReminderTools();
    yield* registerWakeTriggerTools();
    yield* registerJobQueueTools();
    yield* registerContextTools();
    yield* registerSubagentTools();
    yield* registerPerceptionTools();
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
    yield* registerTool(createUpdateWorkStateTool());
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

// NOTE (coordination, 2026-08-28): MemoryService.view/create/strReplace/insert/delete/rename
// just changed their first parameter from `agentId: string` to `scopes: readonly string[]`
// (memory is now partitioned into named scopes like "personal"/"github-project-a" rather than
// one silo per agent). WorkspaceService was structurally identical to the old MemoryService
// shape, which is why `Tool<WorkspaceToolDeps>` typechecked as `Tool<ToolRequirements>` below —
// that coincidence just broke. If this file fails to typecheck with an error naming
// WorkspaceService/MemoryService assignability, it's this change; see the memory-service PR/
// session on this same checkout for context before adjusting WorkspaceService.
export function registerWorkspaceTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(WORKSPACE_CATEGORY);

    yield* registerTool(createViewWorkspaceTool());
    yield* registerTool(createManageWorkspaceTool());
  });
}

/**
 * Registers `ask_peer`, when peers are configured and at least one is not suspended.
 *
 * Config-dependent, so unlike the other groups this reads the config rather than being a
 * fixed list. An agent with no peers never sees the tool at all: a tool the model can see is
 * a tool it will try, and "you have no peers" is a worse answer than never offering.
 */
export function registerPeerTools(): Effect.Effect<void, Error, ToolRegistry | AgentConfigService> {
  return Effect.gen(function* () {
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const tool = createAskPeerTool(appConfig.peers ?? []);
    if (tool === undefined) return;

    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(PEERS_CATEGORY);
    yield* registerTool(tool);
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

export function registerWakeTriggerTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(WAKE_TRIGGER_CATEGORY);

    yield* registerTool(createRegisterTriggerTool());
    yield* registerTool(createListTriggersTool());
    yield* registerTool(createCancelTriggerTool());
  });
}

export function registerJobQueueTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(JOB_QUEUE_CATEGORY);

    const { enqueueBatch, listJobs, cancelBatch } = createJobQueueTools();
    yield* registerTool(enqueueBatch.approval);
    yield* registerTool(enqueueBatch.execute);
    yield* registerTool(listJobs);
    yield* registerTool(cancelBatch);
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
    // Same category: both turn HTML the agent wrote into a file, and both need Chromium.
    yield* registerTool(createPdfTool());
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

export function registerPerceptionTools(): Effect.Effect<void, Error, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const registerTool = registry.registerForCategory(PERCEPTION_CATEGORY);

    for (const tool of createPerceptionTools()) {
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
