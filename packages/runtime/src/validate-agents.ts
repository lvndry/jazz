/**
 * The agent half of `jazz config validate`: every agent file under the
 * configured storage directory must parse, name a provider Jazz knows and a
 * valid reasoning level, and list tools something provides.
 *
 * Runs without the application layer, like the config check, so it works on
 * the broken setup it is meant to diagnose. Built-in tool names come from a
 * throwaway tool registry.
 */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { FileStorageService } from "@jazz/adapters/storage/file";
import { agentConfigProblems } from "@jazz/core/agent/agent-config-problems";
import { registerAllTools } from "@jazz/core/agent/tools/register-tools";
import { createToolRegistryLayer } from "@jazz/core/agent/tools/tool-registry";
import { ToolRegistryTag } from "@jazz/core/interfaces/tool-registry";
import { Effect } from "effect";

/** What `config validate` prints about agents. */
export interface AgentValidationReport {
  readonly agentCount: number;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

function builtinToolNames(): Effect.Effect<ReadonlySet<string>> {
  return Effect.gen(function* () {
    yield* registerAllTools();
    const registry = yield* ToolRegistryTag;
    return new Set(yield* registry.listAllTools());
  }).pipe(
    Effect.provide(createToolRegistryLayer()),
    Effect.catchAll(() => Effect.succeed(new Set<string>())),
  );
}

/** Check every agent file in `storageDirectory`. */
export function validateAgents(storageDirectory: string): Effect.Effect<AgentValidationReport> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const storage = new FileStorageService(storageDirectory, fs);
    const inspection = yield* storage.inspectAgentFiles().pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          agents: [],
          unreadable: [{ path: `${storageDirectory}/agents`, reason: error.reason }],
        }),
      ),
    );
    const tools = yield* builtinToolNames();
    const toolsKnown = tools.size > 0 ? tools : undefined;

    const errors = inspection.unreadable.map((file) => `${file.path}: ${file.reason}`);
    const warnings: string[] = [];
    for (const agent of inspection.agents) {
      for (const problem of agentConfigProblems(agent, toolsKnown)) {
        const line = `agent ${agent.name} (${agent.id}): ${problem.field}: ${problem.message}`;
        if (problem.severity === "error") {
          errors.push(line);
        } else {
          warnings.push(line);
        }
      }
    }
    return { agentCount: inspection.agents.length, errors, warnings };
  }).pipe(Effect.provide(NodeFileSystem.layer));
}
