import { type ChildProcess, spawn } from "child_process";
import { Effect, Option } from "effect";
import type { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { ToolRegistryTag, type Tool, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type {
  Agent,
  CustomToolCommandHandler,
  CustomToolDefinition,
  CustomToolRecordHandler,
} from "@/core/types/agent";
import { AgentConfigurationError } from "@/core/types/errors";
import type { ToolCategory, ToolExecutionResult } from "@/core/types/tools";
import { createSanitizedEnv, type ProcessEnvRecord } from "@/core/utils/env-utils";
import { convertMCPSchemaToZod } from "@/core/utils/mcp-schema-converter";
import { defineTool, makeZodValidator } from "./base-tool";
import { buildKeyFromContext } from "./context-utils";
import { validateCustomToolDefinitionShape } from "./custom-tool-validation";

/**
 * Custom-tool registration module
 *
 * Registers agent-declared `customTools` (see `CustomToolDefinition` in
 * `@/core/types/agent`) into the shared `ToolRegistry`, mirroring the shape
 * of `registerMCPToolsForAgent` in `register-tools.ts`.
 *
 * Two handlers are implemented:
 * - `record`: always returns a fixed response with no side effects.
 * - `command`: spawns `handler.command` directly (no shell), matching
 *   `execute_command`'s env-sanitization, cwd resolution, and timeout/kill
 *   semantics (see `shell-tools.ts`).
 */

/** Hard cap on captured stdout/stderr per command execution, in bytes. */
const COMMAND_OUTPUT_CAP_BYTES = 16 * 1024;

/** Default kill timeout for `command`-handler custom tools when unset. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Extra margin added on top of a command tool's configured `timeoutMs` when
 * registering it with the tool executor (see `buildCommandTool`), so the
 * executor's own timeout can never fire before the command's internal kill
 * timeout has a chance to. */
const EXECUTOR_TIMEOUT_MARGIN_MS = 5_000;

type CommandExecutionOutcome =
  | {
      readonly ok: true;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Append `chunk` to `current`, truncating so the combined string never
 * exceeds `capBytes`. Caps per chunk (not post-hoc) so an unbounded stream
 * never balloons memory before being sliced down.
 */
function appendCapped(current: string, chunk: string, capBytes: number): string {
  if (current.length >= capBytes) {
    return current;
  }
  return current + chunk.slice(0, capBytes - current.length);
}

/**
 * Spawn `argv` directly (no shell), write `stdin` to the child's stdin, and
 * collect stdout/stderr up to `COMMAND_OUTPUT_CAP_BYTES` each. Resolves
 * (never rejects) with either the process outcome or a bounded error message
 * covering spawn failures and timeout kills — mirrors how `execute_command`
 * in `shell-tools.ts` reports failures to the model.
 */
function runCustomToolCommand(
  argv: readonly string[],
  stdin: string,
  cwd: string,
  env: ProcessEnvRecord,
  timeoutMs: number,
): Promise<CommandExecutionOutcome> {
  return new Promise((resolve) => {
    const [command, ...args] = argv;
    if (!command) {
      resolve({ ok: false, error: "Custom tool command is empty" });
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;

    try {
      child = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: false,
      });
    } catch (spawnError) {
      resolve({
        ok: false,
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
      });
      return;
    }

    const finish = (outcome: CommandExecutionOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(outcome);
    };

    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `Command timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout = appendCapped(stdout, data.toString(), COMMAND_OUTPUT_CAP_BYTES);
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr = appendCapped(stderr, data.toString(), COMMAND_OUTPUT_CAP_BYTES);
    });

    child.on("error", (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

    child.on("close", (code) => {
      finish({ ok: true, exitCode: code ?? 0, stdout, stderr });
    });

    // If the child exits before consuming stdin (or never reads it), writing
    // can raise EPIPE. The close/error handlers above still settle the
    // promise, so just prevent an unhandled 'error' event on the stream.
    child.stdin?.on("error", () => {});
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

export const CUSTOM_TOOLS_CATEGORY: ToolCategory = {
  id: "custom_tools",
  displayName: "Custom Tools",
};

/**
 * Build a `Tool` for a `record`-handler custom tool definition.
 *
 * Execution has no side effects: it always succeeds with the handler's fixed
 * `response`, defaulting to `"Recorded."` when omitted.
 */
function buildRecordTool(
  definition: CustomToolDefinition & { readonly handler: CustomToolRecordHandler },
): Tool<never> {
  const parameters = convertMCPSchemaToZod(definition.parameters, definition.name);
  const validate = makeZodValidator(parameters as z.ZodType<Record<string, unknown>>);
  const response = definition.handler.response ?? "Recorded.";

  return {
    ...defineTool<never, Record<string, unknown>>({
      name: definition.name,
      description: definition.description,
      parameters,
      validate,
      // Read-only: fixed response, no side effects — matches defineTool's
      // own default for non-approval tools, set explicitly here for clarity.
      riskLevel: "read-only",
      handler: (): Effect.Effect<ToolExecutionResult, Error, never> =>
        Effect.succeed({ success: true, result: response }),
    }),
    sourceCustomToolDefinition: definition,
  };
}

/**
 * Build a `Tool` for a `command`-handler custom tool definition.
 *
 * Execution spawns `handler.command` argv directly (no shell), with the
 * validated tool arguments serialized as JSON on the child's stdin. Env and
 * cwd resolution match `execute_command`: `createSanitizedEnv({},
 * declaringEnvAllowlist)` for env, and the run's current working directory
 * (via `FileSystemContextService.getCwd`) for cwd — this handler has no
 * `workingDirectory` argument to override it, since the tool's parameters
 * are entirely user-declared. Exit code 0 succeeds with the captured
 * (bounded) stdout; a non-zero exit, timeout, or spawn error produces the
 * same error-result shape `execute_command` uses.
 *
 * `declaringEnvAllowlist` is the `envAllowlist` of the AGENT THAT DECLARED
 * this custom tool (captured once, at registration time), not whichever
 * agent happens to be `context.parentAgent` when the tool is invoked. This
 * matters because subagents can call tools registered by a parent agent
 * (or vice versa) under a `ToolExecutionContext` whose `parentAgent` differs
 * from the declaring agent — using the call-time `context.parentAgent`
 * would silently apply the WRONG agent's allowlist (e.g. leaking a token the
 * declaring agent was never granted, or scrubbing one it was).
 *
 * Command tools spawn arbitrary processes on every invocation with no
 * interactive approval step, so they are always registered `high-risk`
 * regardless of what the command itself does.
 */
function buildCommandTool(
  definition: CustomToolDefinition & { readonly handler: CustomToolCommandHandler },
  declaringEnvAllowlist: readonly string[],
): Tool<FileSystemContextService | LoggerService> {
  const parameters = convertMCPSchemaToZod(definition.parameters, definition.name);
  const validate = makeZodValidator(parameters as z.ZodType<Record<string, unknown>>);
  const commandArgv = definition.handler.command;
  const timeoutMs = definition.handler.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  return {
    ...defineTool<FileSystemContextService | LoggerService, Record<string, unknown>>({
      name: definition.name,
      description: definition.description,
      parameters,
      validate,
      riskLevel: "high-risk",
      // Give the tool executor's own timeout (TOOL_TIMEOUT_MS, 3 minutes by
      // default) a margin above this tool's configured kill timeout, so a
      // command tool configured close to (or past) the 3-minute default
      // executor timeout isn't cut off by the executor before its own
      // internal timeout/kill logic in `runCustomToolCommand` gets a chance
      // to run.
      timeoutMs: timeoutMs + EXECUTOR_TIMEOUT_MARGIN_MS,
      handler: (
        args,
        context,
      ): Effect.Effect<ToolExecutionResult, Error, FileSystemContextService | LoggerService> =>
        Effect.gen(function* () {
          const shell = yield* FileSystemContextServiceTag;
          const logger = yield* LoggerServiceTag;

          const cwd = yield* shell.getCwd(buildKeyFromContext(context));
          const sanitizedEnv = createSanitizedEnv({}, declaringEnvAllowlist);
          const stdinPayload = JSON.stringify(args);

          const outcome = yield* Effect.promise(() =>
            runCustomToolCommand(commandArgv, stdinPayload, cwd, sanitizedEnv, timeoutMs),
          );

          if (!outcome.ok) {
            yield* logger.debug(
              `Custom tool "${definition.name}" command execution failed: ${outcome.error}`,
            );
            return { success: false, result: null, error: outcome.error };
          }

          if (outcome.exitCode !== 0) {
            const message = `Command exited with code ${outcome.exitCode}${
              outcome.stderr ? `: ${outcome.stderr}` : ""
            }`;
            return { success: false, result: null, error: message };
          }

          return { success: true, result: outcome.stdout };
        }),
    }),
    sourceCustomToolDefinition: definition,
  };
}

/**
 * Structural equality for JSON-like values (the shape `CustomToolDefinition`
 * is restricted to: strings, numbers, booleans, null, arrays, and plain
 * objects). Used to tell whether a re-registration is the exact same custom
 * tool definition, or a genuinely different one that happens to share a name.
 */
function isDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => isDeepEqual(item, right[index]));
  }

  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightRecord = right as Record<string, unknown>;
  if (leftEntries.length !== Object.keys(rightRecord).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => isDeepEqual(value, rightRecord[key]));
}

/**
 * Register an agent's declared custom tools into the shared `ToolRegistry`.
 *
 * Only entries whose `name` appears in `agentToolNames` are registered — an
 * agent may declare custom tools it doesn't actually expose to itself (e.g.
 * shared config templates). Every selected definition is re-validated here
 * (via `validateCustomToolDefinitionShape`) even though `AgentServiceImpl.
 * validateAgentConfig` runs the same checks on create/update — an agent
 * config can be loaded from a file or another untrusted source that never
 * went through that path, so registration fails CLOSED on any malformed
 * definition (including an unrecognized `handler.type`) instead of silently
 * treating it as a `record` handler.
 *
 * Colliding with an already-registered tool name (builtin or MCP) fails the
 * run with `AgentConfigurationError` rather than silently overriding the
 * existing registration.
 *
 * `command`-handler entries spawn the declared command directly (no shell)
 * on each invocation, using THIS agent's `envAllowlist` (captured at
 * registration time — see `buildCommandTool`'s doc comment for why call-time
 * `context.parentAgent` would be the wrong source).
 */
export function registerCustomToolsForAgent(
  agent: Agent,
  agentToolNames: readonly string[],
): Effect.Effect<void, Error, ToolRegistry | LoggerService> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    const logger = yield* LoggerServiceTag;

    const customTools = agent.config.customTools ?? [];
    if (customTools.length === 0) {
      return;
    }

    const requestedNames = new Set(agentToolNames);
    const selected = customTools.filter((definition) => requestedNames.has(definition.name));

    if (selected.length === 0) {
      yield* logger.debug(
        "Agent declares custom tools but none are referenced in its tool list, skipping registration",
      );
      return;
    }

    const declaringEnvAllowlist = agent.config.envAllowlist ?? [];
    const registeredToolNames = new Set(yield* registry.listAllTools());

    for (const definition of selected) {
      const shapeIssue = validateCustomToolDefinitionShape(definition);
      if (shapeIssue) {
        yield* Effect.fail(
          new AgentConfigurationError({
            agentId: agent.id,
            field: "config.customTools",
            message: shapeIssue.message,
            suggestion: shapeIssue.suggestion,
          }),
        );
      }

      if (registeredToolNames.has(definition.name)) {
        // The ToolRegistry is a session-lifetime singleton and this function
        // runs on every AgentRunner.run (i.e. every chat turn), so seeing the
        // name again is expected — it's not necessarily a collision. Only
        // fail if the existing registration is NOT this same custom-tool
        // definition (a different custom tool, or a builtin/MCP tool).
        const existingTool = yield* registry.getTool(definition.name).pipe(Effect.option);
        const existingDefinition = existingTool.pipe(
          Option.flatMap((tool) => Option.fromNullable(tool.sourceCustomToolDefinition)),
        );

        if (
          Option.isSome(existingDefinition) &&
          isDeepEqual(existingDefinition.value, definition)
        ) {
          yield* logger.debug(
            `Custom tool "${definition.name}" is already registered with an identical definition, skipping re-registration`,
          );
          continue;
        }

        yield* Effect.fail(
          new AgentConfigurationError({
            agentId: agent.id,
            field: "config.customTools",
            message: `Custom tool "${definition.name}" collides with an already-registered tool (builtin or MCP). Rename the custom tool or remove the conflicting one.`,
            suggestion: `Choose a unique name for the "${definition.name}" custom tool.`,
          }),
        );
      }

      if (definition.handler.type === "command") {
        const commandTool = buildCommandTool(
          definition as CustomToolDefinition & { readonly handler: CustomToolCommandHandler },
          declaringEnvAllowlist,
        );
        yield* registry.registerTool(commandTool, CUSTOM_TOOLS_CATEGORY);
        registeredToolNames.add(definition.name);

        yield* logger.debug(`Registered custom tool "${definition.name}" (command handler)`);
        continue;
      }

      const tool = buildRecordTool(
        definition as CustomToolDefinition & { readonly handler: CustomToolRecordHandler },
      );
      yield* registry.registerTool(tool, CUSTOM_TOOLS_CATEGORY);
      registeredToolNames.add(definition.name);

      yield* logger.debug(`Registered custom tool "${definition.name}" (record handler)`);
    }
  });
}
