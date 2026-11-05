import { registerAllTools } from "@jazz/core/agent/tools/register-tools";
import { createToolRegistryLayer } from "@jazz/core/agent/tools/tool-registry";
import { ToolRegistryTag } from "@jazz/core/interfaces/tool-registry";
import { compactToolJsonSchema } from "@jazz/core/utils/tool-json-schema";
import { zodSchema } from "ai";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { buildToolInputSchema } from "./ai-sdk-service";

/**
 * Built-in tools whose provider-facing schema is guarded. Adding a tool means adding it here,
 * so a change in what the model is sent is always a visible edit.
 */
const GUARDED_TOOL_NAMES = [
  "pwd",
  "ls",
  "cd",
  "stat",
  "read_file",
  "read_pdf",
  "pdf_page_count",
  "grep",
  "find",
  "write_file",
  "edit_file",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "execute_command",
  "wait_for",
  "cancel_wait_for",
  "web_search",
  "web_fetch",
  "http_request",
  "manage_todos",
  "list_todos",
  "update_work_state",
  "view_memory",
  "manage_memory",
  "propose_lesson",
  "view_scratchpad",
  "manage_scratchpad",
  "who_is_here",
  "add_reminder",
  "list_reminders",
  "cancel_reminder",
  "propose_goal",
  "end_loop",
  "report_goal_cycle",
  "register_trigger",
  "list_triggers",
  "cancel_trigger",
  "run_background_jobs",
  "list_background_jobs",
  "cancel_background_jobs",
  "context_info",
  "get_time",
  "retrieve_tool_result",
  "search_tools",
  "spawn_subagent",
  "map_subagents",
  "list_subagents",
  "wait_subagents",
  "steer_subagent",
  "summarize_context",
  "post_to_blackboard",
  "read_blackboard",
  "analyze_media",
  "generate_media",
  "ask_user_question",
  "ask_user_secret",
  "list_saved_secrets",
  "use_saved_secret",
  "ask_file_picker",
  "create_composition",
  "create_pdf",
  "publish_composition",
  "browser_navigate",
  "browser_back",
  "browser_snapshot",
  "browser_screenshot",
  "browser_tabs",
  "browser_close",
  "browser_act",
  "computer_apps",
  "computer_observe",
  "computer_wait",
  "computer_end",
  "computer_pointer",
  "computer_input",
  "computer_foreground",
  "computer_handoff",
  "computer_grant_app",
  "computer_install_driver",
  "computer_acknowledge_driver",
];

async function resolvedJsonSchema(source: unknown): Promise<unknown> {
  return JSON.parse(JSON.stringify(await Promise.resolve(source)));
}

describe("provider-facing tool schemas", () => {
  it("are identical to the plain Zod conversion for every built-in tool", async () => {
    const tools = await Effect.runPromise(
      Effect.gen(function* () {
        yield* registerAllTools();
        const registry = yield* ToolRegistryTag;
        const listed = yield* registry.listTools();
        const collected = [];
        for (const name of listed) {
          collected.push(yield* registry.getTool(name));
        }
        return collected;
      }).pipe(Effect.provide(createToolRegistryLayer())),
    );

    const visibleNames = tools.filter((tool) => tool.hidden !== true).map((tool) => tool.name);
    expect([...visibleNames].sort()).toEqual([...GUARDED_TOOL_NAMES].sort());

    for (const tool of tools) {
      const functionDefinition = {
        name: tool.name,
        parameters: tool.parameters,
        ...(tool.jsonSchema === undefined ? {} : { jsonSchema: tool.jsonSchema }),
      };
      const built = buildToolInputSchema({ function: functionDefinition }).jsonSchema;
      const baseline =
        tool.parameters instanceof z.ZodUnion
          ? undefined
          : compactToolJsonSchema(
              (await resolvedJsonSchema(zodSchema(tool.parameters).jsonSchema)) as Record<
                string,
                unknown
              >,
            );
      if (baseline !== undefined) {
        expect(await resolvedJsonSchema(built)).toEqual(await resolvedJsonSchema(baseline));
      }
    }
  });

  it("validates relaxed arguments and reports them", async () => {
    const parameters = z.object({ query: z.string(), filter: z.string().optional() }).strict();
    const reported: string[] = [];
    const schema = buildToolInputSchema(
      { function: { name: "synthetic", parameters } },
      (toolName, relaxations) => {
        reported.push(`${toolName}:${relaxations.map((entry) => entry.field).join(",")}`);
      },
    );
    const accepted = await schema.validate?.({ query: "q", filter: "", extra: 1 });
    expect(accepted?.success).toBe(true);
    expect(reported).toEqual(["synthetic:filter,extra"]);
    const rejected = await schema.validate?.({ query: 3 });
    expect(rejected?.success).toBe(false);
  });
});
