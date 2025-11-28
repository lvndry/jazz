import { Effect, Layer } from "effect";
import type { AgentConfigService } from "../../interfaces/agent-config";
import type { LoggerService } from "../../interfaces/logger";
import {
  ToolRegistryTag,
  type Tool,
  type ToolRegistry,
  type ToolRequirements,
} from "../../interfaces/tool-registry";
import type {
  ToolCategory,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../types/tools";
import {
  logToolExecutionApproval,
  logToolExecutionError,
  logToolExecutionStart,
  logToolExecutionSuccess,
} from "../../utils/logging-helpers";

/**
 * Tool registry for managing agent tools
 */

class DefaultToolRegistry implements ToolRegistry {
  private tools: Map<string, Tool<ToolRequirements>>;
  private toolCategories: Map<string, string>; // tool name -> category id
  private categories: Map<string, ToolCategory>; // category id -> ToolCategory object

  constructor() {
    this.tools = new Map<string, Tool<ToolRequirements>>();
    this.toolCategories = new Map<string, string>();
    this.categories = new Map<string, ToolCategory>();
  }

  registerTool(tool: Tool<ToolRequirements>, category?: ToolCategory): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.tools.set(tool.name, tool);
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

  getTool(name: string): Effect.Effect<Tool<ToolRequirements>, Error> {
    return Effect.try({
      try: () => {
        const tool = this.tools.get(name);
        if (!tool) {
          throw new Error(`Tool not found: ${name}`);
        }
        return tool;
      },
      catch: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    });
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

  getToolDefinitions(): Effect.Effect<readonly ToolDefinition[], never> {
    return Effect.sync(() => {
      const definitions: ToolDefinition[] = [];

      this.tools.forEach((tool) => {
        definitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        });
      });

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

      // Execute tool and catch all errors (both Effect errors and tool handler errors)
      // Use either to convert errors to success values
      const eitherResult = yield* tool.execute(args, context).pipe(Effect.either);

      let result: ToolExecutionResult;
      if (eitherResult._tag === "Left") {
        const durationMs = Date.now() - start;
        const errorMessage =
          eitherResult.left instanceof Error
            ? eitherResult.left.message
            : String(eitherResult.left);

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
      Effect.catchAll((error: Error) => {
        return Effect.gen(function* () {
          yield* logToolExecutionError(name, 0, error.message);
          return {
            success: false,
            result: null,
            error: error.message,
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
 * @example
 * ```typescript
 * const registerTool = yield* registerForCategory({ id: "email", displayName: "Email" });
 * yield* registerTool(createListEmailsTool());
 * yield* registerTool(createSendEmailTool());
 * ```
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
