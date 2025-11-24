import { Effect, Layer } from "effect";
import type { AgentConfigService } from "../../interfaces/agent-config";
import type { LoggerService } from "../../interfaces/logger";
import {
  ToolRegistryTag,
  type Tool,
  type ToolCategory,
  type ToolExecutionContext,
  type ToolRegistry,
} from "../../interfaces/tool-registry";
import type { ToolDefinition, ToolExecutionResult } from "../../types/tools";
import {
  logToolExecutionApproval,
  logToolExecutionError,
  logToolExecutionStart,
  logToolExecutionSuccess,
} from "../../utils/logging-helpers";

/**
 * Tool registry for managing agent tools
 */

// Re-export core interfaces for backward compatibility
export type {
  Tool,
  ToolCategory,
  ToolExecutionContext,
  ToolRegistry,
} from "../../interfaces/tool-registry";
export type { ToolExecutionResult } from "../../types/tools";

class DefaultToolRegistry implements ToolRegistry {
  private tools: Map<string, Tool<unknown>>;
  private toolCategories: Map<string, string>; // tool name -> category id
  private categories: Map<string, ToolCategory>; // category id -> ToolCategory object

  constructor() {
    this.tools = new Map<string, Tool<unknown>>();
    this.toolCategories = new Map<string, string>();
    this.categories = new Map<string, ToolCategory>();
  }

  registerTool(tool: Tool<unknown>, category?: ToolCategory): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.tools.set(tool.name, tool);
      if (category) {
        // Store category by ID
        this.toolCategories.set(tool.name, category.id);
        // Store category definition if not already present
        if (!this.categories.has(category.id)) {
          this.categories.set(category.id, category);
        }
      }
    });
  }

  registerForCategory(category: ToolCategory): (tool: Tool<unknown>) => Effect.Effect<void, never> {
    return (tool: Tool<unknown>) => this.registerTool(tool, category);
  }

  getTool(name: string): Effect.Effect<Tool<unknown>, Error> {
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
  ): Effect.Effect<ToolExecutionResult, Error, ToolRegistry | LoggerService | AgentConfigService> {
    function* generator(this: DefaultToolRegistry) {
      const start = Date.now();
      const tool = yield* this.getTool(name);

      // Log tool execution start (ignore errors to avoid breaking tool execution)
      yield* logToolExecutionStart(name, args);

      try {
        // Note: tool.execute returns Effect<..., Error, unknown> because tools are stored as Tool<unknown>.
        // TypeScript cannot properly union 'unknown' with other requirements, so we need to explicitly
        // provide the requirements type. The actual requirements are ToolRegistry (via this.getTool),
        // LoggerService, and AgentConfigService (via logging functions).
        const result = yield* tool.execute(args, context) as Effect.Effect<
          ToolExecutionResult,
          Error,
          ToolRegistry | LoggerService | AgentConfigService
        >;
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
      } catch (err) {
        const durationMs = Date.now() - start;
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Log error with improved formatting
        yield* logToolExecutionError(name, durationMs, errorMessage);

        throw err as Error;
      }
    }

    return Effect.gen(generator.bind(this));
  }
}

// Create a layer for providing the tool registry
export function createToolRegistryLayer(): Layer.Layer<ToolRegistry> {
  return Layer.succeed(ToolRegistryTag, new DefaultToolRegistry());
}

// Helper functions for common tool registry operations
export function registerTool(tool: Tool<unknown>): Effect.Effect<void, never, ToolRegistry> {
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
): Effect.Effect<(tool: Tool<unknown>) => Effect.Effect<void, never>, never, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    return registry.registerForCategory(category);
  });
}
