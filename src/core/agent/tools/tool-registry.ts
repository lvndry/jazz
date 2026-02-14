import { Cause, Chunk, Effect, Layer, Option } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import type { LoggerService } from "@/core/interfaces/logger";
import {
  ToolRegistryTag,
  type Tool,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import { ToolNotFoundError } from "@/core/types/errors";
import type {
  ToolCategory,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@/core/types/tools";
import {
  logToolExecutionApproval,
  logToolExecutionError,
  logToolExecutionStart,
  logToolExecutionSuccess,
} from "@/core/utils/logging-helpers";

/**
 * Tool registry for managing agent tools
 */

class DefaultToolRegistry implements ToolRegistry {
  private tools: Map<string, Tool<ToolRequirements>>;
  private toolCategories: Map<string, string>; // tool name -> category id
  private categories: Map<string, ToolCategory>; // category id -> ToolCategory object
  private cachedDefinitions: readonly ToolDefinition[] | null = null;

  constructor() {
    this.tools = new Map<string, Tool<ToolRequirements>>();
    this.toolCategories = new Map<string, string>();
    this.categories = new Map<string, ToolCategory>();
  }

  registerTool(tool: Tool<ToolRequirements>, category?: ToolCategory): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.tools.set(tool.name, tool);
      this.cachedDefinitions = null; // Invalidate cache on registration
      if (category) {
        this.toolCategories.set(tool.name, category.id);

        if (!this.categories.has(category.id)) {
          this.categories.set(category.id, category);
        }
      }
    });
  }

  registerForCategory(
    category: ToolCategory,
  ): (tool: Tool<ToolRequirements>) => Effect.Effect<void, never> {
    return (tool: Tool<ToolRequirements>) => this.registerTool(tool, category);
  }

  getTool(name: string): Effect.Effect<Tool<ToolRequirements>, ToolNotFoundError> {
    return Effect.sync(() => this.tools.get(name)).pipe(
      Effect.flatMap((tool) =>
        tool
          ? Effect.succeed(tool)
          : Effect.fail(
              new ToolNotFoundError({
                toolName: name,
                suggestion: `Check that the tool "${name}" is registered before use.`,
              }),
            ),
      ),
    );
  }

  listTools(): Effect.Effect<readonly string[], never> {
    return Effect.sync(() => {
      const names: string[] = [];
      this.tools.forEach((tool) => {
        if (!tool.hidden) names.push(tool.name);
      });
      return names;
    });
  }

  /**
   * List all registered tool names, including hidden tools.
   * Used for validation to ensure hidden builtin tools can be referenced.
   */
  listAllTools(): Effect.Effect<readonly string[], never> {
    return Effect.sync(() => {
      return Array.from(this.tools.keys());
    });
  }

  getToolDefinitions(): Effect.Effect<readonly ToolDefinition[], never> {
    return Effect.sync(() => {
      if (this.cachedDefinitions !== null) {
        return this.cachedDefinitions;
      }

      const definitions: ToolDefinition[] = [];

      this.tools.forEach((tool) => {
        // Filter out hidden tools - they should not be exposed to the LLM
        // Hidden tools (like execute_* approval tools) are only called by the system
        if (!tool.hidden) {
          definitions.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          });
        }
      });

      this.cachedDefinitions = definitions;
      return definitions;
    });
  }

  listToolsByCategory(): Effect.Effect<Record<string, readonly string[]>, never> {
    return Effect.sync(() => {
      const categories: Record<string, string[]> = {};

      this.tools.forEach((tool, toolName) => {
        if (!tool.hidden) {
          const categoryId = this.toolCategories.get(toolName);
          if (categoryId) {
            const category = this.categories.get(categoryId);
            // Use display name for UI, fallback to ID if category not foun
            const displayName = category?.displayName || categoryId;
            if (!categories[displayName]) {
              categories[displayName] = [];
            }
            categories[displayName].push(toolName);
          } else {
            // Default category for tools without category
            const defaultCategory = "Other";
            if (!categories[defaultCategory]) {
              categories[defaultCategory] = [];
            }
            categories[defaultCategory].push(toolName);
          }
        }
      });

      // Sort tool names within each category
      Object.keys(categories).forEach((category) => {
        const tools = categories[category];
        if (tools) {
          tools.sort();
        }
      });

      return categories;
    });
  }

  getToolsInCategory(categoryId: string): Effect.Effect<readonly string[], never> {
    return Effect.sync(() => {
      const tools: string[] = [];

      this.tools.forEach((tool, toolName) => {
        if (!tool.hidden && this.toolCategories.get(toolName) === categoryId) {
          tools.push(toolName);
        }
      });

      return tools.sort();
    });
  }

  listCategories(): Effect.Effect<readonly ToolCategory[], never> {
    return Effect.sync(() => {
      const categoryIds = new Set<string>();

      this.tools.forEach((tool, toolName) => {
        if (!tool.hidden) {
          const categoryId = this.toolCategories.get(toolName);
          if (categoryId) {
            categoryIds.add(categoryId);
          }
        }
      });

      const categories: ToolCategory[] = Array.from(categoryIds)
        .map((id) => this.categories.get(id))
        .filter((cat): cat is ToolCategory => cat !== undefined)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      return categories;
    });
  }

  executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Effect.Effect<
    ToolExecutionResult,
    never,
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements
  > {
    // Capture this to avoid issues with Effect.gen not preserving context
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const registry = this;
    return Effect.gen(function* () {
      const start = Date.now();
      // getTool errors should fail fast (tool not found is a critical error)
      const tool = yield* registry.getTool(name);

      yield* logToolExecutionStart(name, args);

      // Execute tool and catch all errors (both Effect typed failures and defects/throws)
      // Use sandbox to promote defects into the error channel, then either to convert to values
      const eitherResult = yield* tool.execute(args, context).pipe(Effect.sandbox, Effect.either);

      let result: ToolExecutionResult;
      if (eitherResult._tag === "Left") {
        const durationMs = Date.now() - start;
        const cause = eitherResult.left;

        // Extract error message from the Cause: check typed failure first, then defects
        const failureOpt = Cause.failureOption(cause);
        let errorMessage: string;
        if (Option.isSome(failureOpt)) {
          const failure = failureOpt.value;
          errorMessage = failure instanceof Error ? failure.message : String(failure);
        } else {
          const defects = Cause.defects(cause);
          const firstDefect = Chunk.get(defects, 0);
          errorMessage = Option.isSome(firstDefect)
            ? firstDefect.value instanceof Error
              ? firstDefect.value.message
              : String(firstDefect.value)
            : "Unknown error";
        }

        yield* logToolExecutionError(name, durationMs, errorMessage);

        result = {
          success: false,
          result: null,
          error: errorMessage,
        };
      } else {
        // Effect succeeded - use the result
        result = eitherResult.right;
      }

      const durationMs = Date.now() - start;

      if (result.success) {
        // Create a summary of the result for better logging
        const resultSummary = tool.createSummary?.(result);

        // Log successful execution with improved formatting
        yield* logToolExecutionSuccess(name, durationMs, resultSummary, result.result);
      } else {
        // If this is an approval-required response, log as warning with special label
        const resultObj = result.result as
          | { approvalRequired?: boolean; message?: string }
          | undefined;
        const isApproval = resultObj?.approvalRequired === true;
        if (isApproval) {
          const approvalMsg = resultObj?.message || result.error || "Approval required";
          yield* logToolExecutionApproval(name, durationMs, approvalMsg);
        } else {
          const errorMessage = result.error || "Tool returned success=false";
          yield* logToolExecutionError(name, durationMs, errorMessage);
        }
      }

      return result;
    }).pipe(
      Effect.catchAll((error: ToolNotFoundError | Error) => {
        return Effect.gen(function* () {
          const errorMessage = error instanceof Error ? error.message : String(error);
          yield* logToolExecutionError(name, 0, errorMessage);
          return {
            success: false,
            result: null,
            error: errorMessage,
          } as ToolExecutionResult;
        });
      }),
    );
  }
}

// Create a layer for providing the tool registry
export function createToolRegistryLayer(): Layer.Layer<ToolRegistry> {
  return Layer.succeed(ToolRegistryTag, new DefaultToolRegistry());
}

// Helper functions for common tool registry operations
export function registerTool(
  tool: Tool<ToolRequirements>,
): Effect.Effect<void, never, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    return yield* registry.registerTool(tool);
  });
}

/**
 * Create a category-scoped tool registration function
 *
 * Returns a function that registers tools under a specific category.
 * This provides a clean API for registering multiple tools in the same category
 * without having to pass the category to each registration call.
 *
 * @param category - The category object with id and displayName
 * @returns A function that registers tools under the specified category
 *
 */
export function registerForCategory(
  category: ToolCategory,
): Effect.Effect<
  (tool: Tool<ToolRequirements>) => Effect.Effect<void, never>,
  never,
  ToolRegistry
> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    return registry.registerForCategory(category);
  });
}
