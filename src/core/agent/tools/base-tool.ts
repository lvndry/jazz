import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";

/**
 * Lightweight, reusable tool builder with optional runtime validation.
 * Uses Zod schemas to ensure tool arguments stay in sync with runtime validation.
 */

export interface ToolValidatorResult<Args extends Record<string, unknown>> {
  readonly valid: boolean;
  readonly value?: Args;
  readonly errors?: readonly string[];
}

export type ToolValidator<Args extends Record<string, unknown>> = (
  args: Record<string, unknown>,
) => ToolValidatorResult<Args>;

export interface BaseToolConfig<R, Args extends Record<string, unknown>> {
  /**
   * name for the tool.
   */
  readonly name: string;
  /**
   * Human-readable description of what the tool does.
   *
   * This description is provided to the LLM to help it understand when and
   * how to use the tool. It should be clear, concise, and explain the tool's
   * purpose, what it accomplishes, and any important context about when it
   * should be used. The LLM uses this description to decide whether to call
   * the tool in a given situation.
   *
   */
  readonly description: string;
  /**
   * Optional array of tags for categorizing and organizing tools.
   *
   * Tags can be used to group related tools together, filter tools by category,
   * or provide additional metadata about the tool's purpose or domain. Common
   * tag categories include domain (e.g., "git", "email", "filesystem"),
   * operation type (e.g., "read", "write", "delete"), or feature area
   * (e.g., "communication", "version-control", "data-processing").
   *
   * @example
   * ```typescript
   * tags: ["git", "version-control", "write"]
   * tags: ["email", "communication", "send"]
   * tags: ["filesystem", "read", "file"]
   * ```
   */
  readonly tags?: readonly string[];
  /**
   * Zod schema defining the structure and validation rules for tool arguments.
   *
   * This schema is used to:
   * - Generate JSON Schema for LLM tool definitions
   * - Validate arguments at runtime when the tool is executed
   * - Provide type safety and ensure arguments match expected structure
   *
   * The schema should define all required and optional parameters that the tool
   * accepts, including their types, descriptions, and any validation constraints.
   * When combined with the `validate` function, this provides both schema-level
   * and custom validation logic.
   *
   */
  readonly parameters: z.ZodTypeAny;
  /** If true, hide this tool from UI listings while keeping it callable. */
  readonly hidden?: boolean;
  /**
   * Optional function to validate the tool arguments before execution.
   *
   * This validator runs after the LLM provides arguments but before the handler
   * is called. It provides runtime type checking and custom validation logic
   * beyond what JSON Schema can express. The validator should return a result
   * indicating whether the arguments are valid and provide any error messages
   * for invalid inputs.
   *
   * @example
   * ```typescript
   * validate: (args) => {
   *   if (args.email && !args.email.includes('@')) {
   *     return { valid: false, errors: ['Invalid email format'] };
   *   }
   *   return { valid: true, value: args };
   * }
   * ```
   */
  readonly validate?: ToolValidator<Args>;
  /**
   * Optional approval requirement for destructive tools.
   * If provided, the tool will ALWAYS show the approval message and require user confirmation.
   * The LLM cannot bypass this by setting any field - it must ask the user for confirmation.
   */
  readonly approval?: {
    /**
     * Create a human-readable message explaining what will happen.
     * Used to guide the agent to ask the user for confirmation.
     * Can be async to fetch additional context (like email details).
     */
    readonly message: (
      args: Args,
      context: ToolExecutionContext,
    ) => Effect.Effect<string, Error, R>;
    /**
     * Custom error message when approval is required. Defaults to generic message.
     */
    readonly errorMessage?: string;
    /**
     * Optional execution callback that defines which tool to call on user approval
     * and how to build its arguments from the validated input.
     */
    readonly execute?: {
      readonly toolName: string;
      readonly buildArgs: (args: Args) => Record<string, unknown>;
    };
  };
  /**
   * The main function that handles the tool execution logic.
   *
   * This is the core implementation of the tool that performs the actual work.
   * It receives validated arguments and execution context, and returns an Effect
   * that represents the asynchronous operation. The handler should handle all
   * business logic, external API calls, file operations, or other side effects
   * required by the tool.
   *
   * The function must return a ToolExecutionResult that indicates success or failure,
   * along with any relevant data or error messages. All side effects should be
   * wrapped in Effect to ensure proper error handling and resource management.
   *
   * @param args - The validated arguments passed to the tool
   * @param context - The execution context containing environment, logger, and other services
   * @returns An Effect that resolves to a ToolExecutionResult
   *
   * @example
   * ```typescript
   * handler: (args, context) => Effect.gen(function* () {
   *   const logger = yield* context.logger;
   *   yield* logger.info(`Processing request: ${args.id}`);
   *
   *   const result = yield* processRequest(args);
   *   return { success: true, result };
   * })
   * ```
   */
  readonly handler: (
    args: Args,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, R>;
  /**
   * Optional function to create a human-readable summary of the tool execution result.
   *
   * This function is called after the tool execution completes successfully and is used
   * to generate a concise, user-friendly summary of what the tool accomplished. The
   * summary is typically displayed to the user or logged for audit purposes. If not
   * provided, a default summary will be generated based on the tool name and success status.
   *
   * The function receives the complete ToolExecutionResult and should return a string
   * that clearly describes the outcome. Return undefined to use the default summary
   * generation logic.
   *
   * @param result - The complete execution result from the tool handler
   * @returns A human-readable summary string, or undefined to use default summary
   *
   * @example
   * ```typescript
   * createSummary: (result) => {
   *   if (result.success && result.result) {
   *     return `Successfully processed ${result.result.count} items`;
   *   }
   *   return `Tool execution ${result.success ? 'succeeded' : 'failed'}`;
   * }
   * ```
   */
  readonly createSummary?: (result: ToolExecutionResult) => string | undefined;
}

/**
 * Define a new tool with validation and approval capabilities
 *
 * Creates a tool from the provided configuration, including optional validation
 * and approval requirements. The tool can be configured to require user approval
 * for destructive operations and includes comprehensive argument validation.
 *
 * @param config - The tool configuration including name, description, parameters, validation, and approval settings
 * @returns A Tool object that can be registered and executed
 *
 * @example
 * ```typescript
 * const emailTool = defineTool({
 *   name: "send_email",
 *   description: "Send an email to a recipient",
 *   parameters: {
 *     to: { type: "string", description: "Recipient email address" },
 *     subject: { type: "string", description: "Email subject" }
 *   },
 *   handler: async (args, context) => {
 *     // Tool implementation
 *     return { success: true, result: "Email sent" };
 *   }
 * });
 * ```
 */
export function defineTool<R, Args extends Record<string, unknown>>(
  config: BaseToolConfig<R, Args>,
): Tool<R> {
  const approvalExecuteToolName = config.approval?.execute?.toolName;

  return {
    name: config.name,
    description: config.description,
    tags: config.tags ?? [],
    parameters: config.parameters,
    hidden: config.hidden === true,
    ...(approvalExecuteToolName ? { approvalExecuteToolName } : {}),
    createSummary: config.createSummary,
    execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Effect.Effect<ToolExecutionResult, Error, R> {
      if (config.validate) {
        const result = config.validate(args);
        if (!result.valid) {
          const message = (result.errors || ["Invalid arguments"]).join("; ");
          return Effect.succeed({ success: false, result: null, error: message });
        }
        const validated = result.value as Args;
        // Enforce approval if configured
        if (config.approval) {
          // Return an approval request payload
          return Effect.gen(function* () {
            const approval = config.approval as NonNullable<typeof config.approval>;
            const approvalMessage = yield* approval.message(validated, context);
            const execute = approval.execute;
            return {
              success: false,
              result: {
                approvalRequired: true,
                message: approvalMessage,
                ...(execute
                  ? {
                      instruction: `Please ask the user for confirmation. If they confirm, ${execute.toolName} with these exact arguments: ${JSON.stringify(execute.buildArgs(validated))}`,
                      executeToolName: execute.toolName,
                      executeArgs: execute.buildArgs(validated),
                    }
                  : {}),
              },
              error:
                approval.errorMessage ??
                "Approval required: This action requires user confirmation.",
            } as ToolExecutionResult;
          });
        }
        return config.handler(validated, context);
      }

      // No validation configured; pass through
      return config.handler(args as Args, context);
    },
  };
}

/**
 * Build a runtime validator from a Zod schema. Keeps validation logic and typing in sync.
 */
export function makeZodValidator<Args extends Record<string, unknown>>(
  schema: z.ZodType<Args>,
): ToolValidator<Args> {
  return (args: Record<string, unknown>) => {
    const result = schema.safeParse(args);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      });
      return { valid: false, errors } as const;
    }
    return { valid: true, value: result.data } as const;
  };
}

/**
 * Format a tool description with the "APPROVAL REQUIRED" prefix.
 * Standardizes the format for tools that require user approval before execution.
 *
 * @param description - The base description of the tool
 * @returns The description prefixed with the approval required marker
 *
 * @example
 * ```typescript
 * description: formatApprovalRequiredDescription(
 *   "Create a new event in Google Calendar with specified details."
 * )
 * // Returns: "⚠️ APPROVAL REQUIRED: Create a new event in Google Calendar with specified details."
 * ```
 */
export function formatApprovalRequiredDescription(description: string): string {
  return `⚠️ APPROVAL REQUIRED: ${description}`;
}

/**
 * Format a tool description with the "EXECUTION TOOL" prefix.
 * Standardizes the format for execution tools that perform actions after approval.
 *
 * @param description - The base description of the tool
 * @returns The description prefixed with the execution tool marker
 *
 * @example
 * ```typescript
 * description: formatExecutionToolDescription(
 *   "Performs the actual calendar event creation after user approval."
 * )
 * // Returns: "🔧 EXECUTION TOOL: Performs the actual calendar event creation after user approval."
 * ```
 */
export function formatExecutionToolDescription(description: string): string {
  return `🔧 EXECUTION TOOL: ${description}`;
}
