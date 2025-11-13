import { Context, Effect, Layer } from "effect";
import type z from "zod";
import type { ConfigService } from "../../../services/config";
import { type ToolDefinition } from "../../../services/llm/types";
import {
  type LoggerService,
  logToolExecutionApproval,
  logToolExecutionError,
  logToolExecutionStart,
  logToolExecutionSuccess,
} from "../../../services/logger";

/**
 * Tool registry for managing agent tools
 */

export interface ToolExecutionContext {
  readonly agentId: string;
  readonly conversationId?: string;
  readonly userId?: string;
  readonly [key: string]: unknown;
}

export interface ToolExecutionResult {
  readonly success: boolean;
  readonly result: unknown;
  readonly error?: string;
}

export interface ToolRoutingMetadata {
  readonly tags: readonly string[];
  readonly keywords: readonly string[];
  readonly examples?: readonly string[];
  readonly priority?: number;
}

export interface Tool<R = never> {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodTypeAny;
  /** If true, this tool is hidden from UI listings (but still usable programmatically). */
  readonly hidden: boolean;
  readonly routing: ToolRoutingMetadata;
  readonly execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, R>;
  /** Optional function to create a summary of the tool execution result */
  readonly createSummary: ((result: ToolExecutionResult) => string | undefined) | undefined;
}

export interface ToolRegistry {
  readonly registerTool: (tool: Tool<unknown>, category?: string) => Effect.Effect<void, never>;
  readonly registerForCategory: (
    category: string,
  ) => (tool: Tool<unknown>) => Effect.Effect<void, never>;
  readonly getTool: (name: string) => Effect.Effect<Tool<unknown>, Error>;
  readonly listTools: () => Effect.Effect<readonly string[], never>;
  readonly getToolDefinitions: () => Effect.Effect<readonly ToolDefinition[], never>;
  readonly getToolRoutingMetadata: () => Effect.Effect<Record<string, ToolRoutingMetadata>, never>;
  readonly listToolsByCategory: () => Effect.Effect<Record<string, readonly string[]>, never>;
  readonly getToolsInCategory: (category: string) => Effect.Effect<readonly string[], never>;
  readonly listCategories: () => Effect.Effect<readonly string[], never>;
  readonly executeTool: (
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, ToolRegistry | LoggerService | ConfigService>;
}

class DefaultToolRegistry implements ToolRegistry {
  private tools: Map<string, Tool<unknown>>;
  private toolCategories: Map<string, string>;
  private routingMetadata: Map<string, ToolRoutingMetadata>;

  constructor() {
    this.tools = new Map<string, Tool<unknown>>();
    this.toolCategories = new Map<string, string>();
    this.routingMetadata = new Map<string, ToolRoutingMetadata>();
  }

  registerTool(tool: Tool<unknown>, category?: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.tools.set(tool.name, tool);
      this.routingMetadata.set(tool.name, tool.routing);
      if (category) {
        this.toolCategories.set(tool.name, category);
      }
    });
  }

  registerForCategory(category: string): (tool: Tool<unknown>) => Effect.Effect<void, never> {
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

  getToolRoutingMetadata(): Effect.Effect<Record<string, ToolRoutingMetadata>, never> {
    return Effect.sync(() => {
      const metadata: Record<string, ToolRoutingMetadata> = {};
      this.routingMetadata.forEach((value, key) => {
        metadata[key] = value;
      });
      return metadata;
    });
  }

  listToolsByCategory(): Effect.Effect<Record<string, readonly string[]>, never> {
    return Effect.sync(() => {
      const categories: Record<string, string[]> = {};

      this.tools.forEach((tool, toolName) => {
        if (!tool.hidden) {
          const category = this.toolCategories.get(toolName) || "Other";
          if (!categories[category]) {
            categories[category] = [];
          }
          categories[category].push(toolName);
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

  getToolsInCategory(category: string): Effect.Effect<readonly string[], never> {
    return Effect.sync(() => {
      const tools: string[] = [];

      this.tools.forEach((tool, toolName) => {
        if (!tool.hidden && this.toolCategories.get(toolName) === category) {
          tools.push(toolName);
        }
      });

      return tools.sort();
    });
  }

  listCategories(): Effect.Effect<readonly string[], never> {
    return Effect.sync(() => {
      const categories = new Set<string>();

      this.tools.forEach((tool, toolName) => {
        if (!tool.hidden) {
          const category = this.toolCategories.get(toolName) || "Other";
          categories.add(category);
        }
      });

      return Array.from(categories).sort();
    });
  }

  executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Effect.Effect<ToolExecutionResult, Error, ToolRegistry | LoggerService | ConfigService> {
    return Effect.gen(
      function* (this: DefaultToolRegistry) {
        const start = Date.now();
        const tool = yield* this.getTool(name);

        // Log tool execution start
        yield* logToolExecutionStart(name, context.agentId, context.conversationId).pipe(
          Effect.catchAll(() => Effect.void),
        );

        try {
          const exec = tool.execute as (
            a: Record<string, unknown>,
            c: ToolExecutionContext,
          ) => Effect.Effect<ToolExecutionResult, Error, never>;
          const result = yield* exec(args, context);
          const durationMs = Date.now() - start;

          if (result.success) {
            // Create a summary of the result for better logging
            const resultSummary = tool.createSummary?.(result);

            // Log successful execution with improved formatting
            yield* logToolExecutionSuccess(
              name,
              context.agentId,
              durationMs,
              context.conversationId,
              resultSummary,
            ).pipe(Effect.catchAll(() => Effect.void));
          } else {
            // If this is an approval-required response, log as warning with special label
            const resultObj = result.result as
              | { approvalRequired?: boolean; message?: string }
              | undefined;
            const isApproval = resultObj?.approvalRequired === true;
            if (isApproval) {
              const approvalMsg = resultObj?.message || result.error || "Approval required";
              yield* logToolExecutionApproval(
                name,
                context.agentId,
                durationMs,
                approvalMsg,
                context.conversationId,
              ).pipe(Effect.catchAll(() => Effect.void));
            } else {
              const errorMessage = result.error || "Tool returned success=false";
              yield* logToolExecutionError(
                name,
                context.agentId,
                durationMs,
                errorMessage,
                context.conversationId,
              ).pipe(Effect.catchAll(() => Effect.void));
            }
          }

          return result;
        } catch (err) {
          const durationMs = Date.now() - start;
          const errorMessage = err instanceof Error ? err.message : String(err);

          // Log error with improved formatting
          yield* logToolExecutionError(
            name,
            context.agentId,
            durationMs,
            errorMessage,
            context.conversationId,
          ).pipe(Effect.catchAll(() => Effect.void));

          throw err as Error;
        }
      }.bind(this),
    );
  }
}

// Create a service tag for dependency injection
export const ToolRegistryTag = Context.GenericTag<ToolRegistry>("ToolRegistry");

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
 * @param category - The category name for the tools
 * @returns A function that registers tools under the specified category
 *
 * @example
 * ```typescript
 * const registerTool = yield* registerForCategory("Email");
 * yield* registerTool(createListEmailsTool());
 * yield* registerTool(createSendEmailTool());
 * ```
 */
export function registerForCategory(
  category: string,
): Effect.Effect<(tool: Tool<unknown>) => Effect.Effect<void, never>, never, ToolRegistry> {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistryTag;
    return registry.registerForCategory(category);
  });
}
