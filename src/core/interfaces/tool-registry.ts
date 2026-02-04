import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";
import type z from "zod";
import type { SkillService } from "@/core/skills/skill-service";
import type {
    ToolCategory,
    ToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
} from "../types";
import type { AgentConfigService } from "./agent-config";
import type { CalendarService } from "./calendar";
import type { FileSystemContextService } from "./fs";
import type { GmailService } from "./gmail";
import type { LoggerService } from "./logger";
import type { MCPServerManager } from "./mcp-server";
import type { TerminalService } from "./terminal";

/**
 * Risk level for tool execution.
 * Used to determine auto-approval behavior in workflows.
 *
 * - `read-only`: Tools that only read data (web search, list emails, read files)
 * - `low-risk`: Tools that make minor changes (archive email, create calendar event)
 * - `high-risk`: Tools that make significant changes (delete files, send email, execute commands)
 */
export type ToolRiskLevel = "read-only" | "low-risk" | "high-risk";

/**
 * Union type representing all possible tool requirements.
 * This allows the registry to store tools with different requirement types
 *
 * Note: Tools with `never` requirements are still assignable to `Tool<ToolRequirements>`
 * because `never` is a bottom type that's compatible with any union.
 */
export type ToolRequirements =
  | FileSystemContextService
  | FileSystem.FileSystem
  | GmailService
  | CalendarService
  | AgentConfigService
  | LoggerService
  | MCPServerManager
  | TerminalService
  | SkillService;

export interface Tool<R = never> {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly parameters: z.ZodTypeAny;
  /** If true, this tool is hidden from UI listings (but still usable programmatically). */
  readonly hidden: boolean;
  /**
   * Risk level for auto-approval in workflows.
   * - `read-only`: Always auto-approved (default for non-approval tools)
   * - `low-risk`: Auto-approved when workflow allows low-risk operations
   * - `high-risk`: Only auto-approved when explicitly allowed (default for approval tools)
   */
  readonly riskLevel: ToolRiskLevel;
  /**
   * Optional helper for approval-based tools pointing to the follow-up tool name
   * that should be made available once user confirmation is granted.
   */
  readonly approvalExecuteToolName?: string;
  /**
   * Executes the tool with the provided arguments and context.
   *
   * This is the core execution method that performs the actual work of the tool.
   * It receives validated arguments (typically from an LLM function call) and
   * execution context, then returns an Effect that represents the asynchronous
   * operation with proper error handling and dependency requirements.
   *
   * @param args - The tool arguments as a record of key-value pairs. These are
   *               typically provided by the LLM and should match the tool's
   *               parameter schema.
   * @param context - The execution context containing agent ID, conversation ID,
   *                  user ID, and other contextual information.
   * @returns An Effect that resolves to a ToolExecutionResult, which indicates
   *          success or failure along with any result data or error messages.
   *          The Effect's requirements type `R` represents the services this
   *          tool depends on (e.g., GmailService, FileSystem, LoggerService).
   */
  readonly execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, R>;
  /** Optional function to create a summary of the tool execution result */
  readonly createSummary: ((result: ToolExecutionResult) => string | undefined) | undefined;
}

/**
 * Registry for managing and executing agent tools.
 *
 * The ToolRegistry provides a centralized way to register, discover, and execute
 * tools that agents can use. Tools are organized by categories for better
 * organization and discovery. The registry handles tool execution with proper
 * error handling, logging, and dependency management.
 */
export interface ToolRegistry {
  /**
   * Registers a tool in the registry, optionally assigning it to a category.
   *
   * Once registered, the tool becomes available for discovery and execution.
   * If a category is provided, the tool will be grouped with other tools in
   * that category for better organization.
   *
   * @param tool - The tool to register. Must be a Tool with requirements
   *               that are part of the ToolRequirements union type.
   * @param category - Optional category to assign the tool to. If provided,
   *                   the tool will be grouped with other tools in this category.
   * @returns An Effect that completes when the tool is registered.
   */
  readonly registerTool: (
    tool: Tool<ToolRequirements>,
    category?: ToolCategory,
  ) => Effect.Effect<void, never>;
  /**
   * Creates a category-scoped tool registration function.
   *
   * Returns a function that registers tools under a specific category.
   * This provides a convenient API for registering multiple tools in the same
   * category without having to pass the category to each registration call.
   *
   * @param category - The category to scope tool registrations to.
   * @returns A function that registers tools under the specified category.
   *
   * @example
   * ```typescript
   * const registerTool = yield* registry.registerForCategory({ id: "email", displayName: "Email" });
   * yield* registerTool(createListEmailsTool());
   * yield* registerTool(createSendEmailTool());
   * ```
   */
  readonly registerForCategory: (
    category: ToolCategory,
  ) => (tool: Tool<ToolRequirements>) => Effect.Effect<void, never>;
  /**
   * Retrieves a tool by name from the registry.
   *
   * @param name - The name of the tool to retrieve.
   * @returns An Effect that resolves to the tool, or fails with an Error
   *          if the tool is not found.
   */
  readonly getTool: (name: string) => Effect.Effect<Tool<ToolRequirements>, Error>;
  /**
   * Lists all registered tool names.
   *
   * Returns only non-hidden tools. Hidden tools are excluded from listings
   * but remain callable programmatically.
   *
   * @returns An Effect that resolves to an array of tool names.
   */
  readonly listTools: () => Effect.Effect<readonly string[], never>;
  /**
   * Gets tool definitions in the format expected by LLM function calling APIs.
   *
   * Returns tool definitions that can be passed to LLM APIs to enable
   * function calling. Each definition includes the tool name, description,
   * and parameter schema.
   *
   * @returns An Effect that resolves to an array of ToolDefinition objects.
   */
  readonly getToolDefinitions: () => Effect.Effect<readonly ToolDefinition[], never>;
  /**
   * Lists tools organized by category.
   *
   * Returns a record where keys are category display names and values are
   * arrays of tool names in that category. Tools without a category are
   * grouped under "Other".
   *
   * @returns An Effect that resolves to a record mapping category names to
   *          arrays of tool names.
   */
  readonly listToolsByCategory: () => Effect.Effect<Record<string, readonly string[]>, never>;
  /**
   * Gets all tools in a specific category.
   *
   * @param categoryId - The ID of the category to filter by.
   * @returns An Effect that resolves to an array of tool names in the
   *          specified category, sorted alphabetically.
   */
  readonly getToolsInCategory: (categoryId: string) => Effect.Effect<readonly string[], never>;
  /**
   * Lists all registered categories.
   *
   * Returns categories that have at least one non-hidden tool assigned to them.
   *
   * @returns An Effect that resolves to an array of ToolCategory objects,
   *          sorted by display name.
   */
  readonly listCategories: () => Effect.Effect<readonly ToolCategory[], never>;
  /**
   * Executes a tool by name with the provided arguments and context and returns the result.
   *
   * @param name - The name of the tool to execute.
   * @param args - The arguments to pass to the tool, typically provided by
   *               an LLM function call.
   * @param context - The execution context containing agent ID, conversation
   *                  ID, user ID, and other contextual information.
   * @returns An Effect that resolves to a ToolExecutionResult indicating
   *          success or failure, along with any result data or error messages.
   *          The Effect requires ToolRegistry, LoggerService, AgentConfigService,
   *          and any services required by the tool itself.
   */
  readonly executeTool: (
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Effect.Effect<
    ToolExecutionResult,
    never,
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements
  >;
}

export const ToolRegistryTag = Context.GenericTag<ToolRegistry>("ToolRegistry");
