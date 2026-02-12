import { Effect } from "effect";
import { z } from "zod";
import type { Tool, ToolRiskLevel } from "@/core/interfaces/tool-registry";
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
   */
  readonly description: string;
  /**
   * Optional array of tags for categorizing and organizing tools.
   */
  readonly tags?: readonly string[];
  /**
   * Zod schema defining the structure and validation rules for tool arguments.
   */
  readonly parameters: z.ZodTypeAny;
  /** If true, hide this tool from UI listings while keeping it callable. */
  readonly hidden?: boolean;
  /**
   * Risk level for auto-approval in workflows.
   * Defaults to "read-only" for regular tools, "high-risk" for approval tools.
   */
  readonly riskLevel?: ToolRiskLevel;
  /**
   * Optional function to validate the tool arguments before execution.
   */
  readonly validate?: ToolValidator<Args>;
  /**
   * The main function that handles the tool execution logic.
   */
  readonly handler: (
    args: Args,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, R>;
  /**
   * Optional function to create a human-readable summary of the tool execution result.
   */
  readonly createSummary?: (result: ToolExecutionResult) => string | undefined;
  /**
   * Internal: Name of the execution tool to call after approval.
   * Set automatically by defineApprovalTool.
   */
  readonly approvalExecuteToolName?: string;
  /**
   * If true, this tool is expected to take a long time.
   * The UI will skip the "taking longer than expected" warning.
   */
  readonly longRunning?: boolean;
  /**
   * Custom timeout in milliseconds. Overrides the default 3-minute timeout.
   */
  readonly timeoutMs?: number;
}

/**
 * Define a new tool with validation capabilities
 *
 * Creates a tool from the provided configuration, including optional validation.
 * For approval-required tools, use `defineApprovalTool` instead.
 */
export function defineTool<R, Args extends Record<string, unknown>>(
  config: BaseToolConfig<R, Args>,
): Tool<R> {
  // Default risk level: "read-only" for regular tools, "high-risk" if it has approval
  const defaultRiskLevel: ToolRiskLevel = config.approvalExecuteToolName
    ? "high-risk"
    : "read-only";

  return {
    name: config.name,
    description: config.description,
    tags: config.tags ?? [],
    parameters: config.parameters,
    hidden: config.hidden === true,
    riskLevel: config.riskLevel ?? defaultRiskLevel,
    ...(config.approvalExecuteToolName
      ? { approvalExecuteToolName: config.approvalExecuteToolName }
      : {}),
    ...(config.longRunning ? { longRunning: true } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
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
 */
export function formatApprovalRequiredDescription(description: string): string {
  return `⚠️ APPROVAL REQUIRED: ${description}`;
}

/**
 * Format a tool description with the "EXECUTION TOOL" prefix.
 */
export function formatExecutionToolDescription(description: string): string {
  return `🔧 EXECUTION TOOL: ${description}`;
}

/**
 * Configuration for defining approval-required tools.
 * Creates both the approval tool (shown to LLM) and execution tool (hidden) from one definition.
 */
export interface ApprovalToolConfig<R, Args extends Record<string, unknown>> {
  /** Tool name (e.g., "write_file") - execution tool will be auto-named "execute_write_file" */
  readonly name: string;
  /** Description of what the tool does (will be prefixed with approval marker) */
  readonly description: string;
  /** Optional tags for categorization */
  readonly tags?: readonly string[];
  /** Zod schema for parameters */
  readonly parameters: z.ZodTypeAny;
  /**
   * Risk level for auto-approval in workflows.
   * Defaults to "high-risk" for approval tools.
   */
  readonly riskLevel?: ToolRiskLevel;
  /** Optional custom validator */
  readonly validate?: ToolValidator<Args>;
  /** Generate the approval message shown to the user. Can return a string or structured result with previewDiff. */
  readonly approvalMessage: (
    args: Args,
    context: ToolExecutionContext,
  ) => Effect.Effect<string | { message: string; previewDiff?: string }, Error, R>;
  /** Custom error message when approval is required */
  readonly approvalErrorMessage?: string;
  /** The actual execution handler (runs after approval) */
  readonly handler: (
    args: Args,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, R>;
  /** Optional summary generator */
  readonly createSummary?: (result: ToolExecutionResult) => string | undefined;
}

/**
 * Result of defineApprovalTool - contains both the approval and execution tools
 */
export interface ApprovalToolPair<R> {
  /** The approval tool (shown to LLM, returns approval-required) */
  readonly approval: Tool<R>;
  /** The execution tool (hidden, called by system after user approves) */
  readonly execute: Tool<R>;
  /** Convenience method to get both tools as an array for registration */
  readonly all: () => readonly [Tool<R>, Tool<R>];
}

/**
 * Define an approval-required tool.
 *
 * Creates an `ApprovalToolPair` containing:
 * - `approval`: Shown to LLM, returns `approvalRequired: true` with the approval message
 * - `execute`: Hidden, contains the actual handler, called by system after user approves
 *
 * @example
 * ```typescript
 * const writeFileTools = defineApprovalTool({
 *   name: "write_file",
 *   description: "Write content to a file",
 *   parameters: writeFileSchema,
 *   approvalMessage: (args) => Effect.succeed(`About to write to ${args.path}`),
 *   handler: (args, context) => Effect.gen(function* () {
 *     return { success: true, result: { path: args.path } };
 *   }),
 * });
 *
 * // Register both tools
 * yield* registerTool(writeFileTools.approval);
 * yield* registerTool(writeFileTools.execute);
 * ```
 */
export function defineApprovalTool<R, Args extends Record<string, unknown>>(
  config: ApprovalToolConfig<R, Args>,
): ApprovalToolPair<R> {
  const executeToolName = `execute_${config.name}`;
  const riskLevel = config.riskLevel ?? "high-risk";

  const validator: ToolValidator<Args> =
    config.validate ??
    ((args) => {
      const result = config.parameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as Args }
        : { valid: false, errors: result.error.issues.map((i: z.ZodIssue) => i.message) };
    });

  const errorMessage =
    config.approvalErrorMessage ?? `Approval required: ${config.name} requires user confirmation.`;

  // Create the approval tool (shown to LLM)
  const approvalTool = defineTool<R, Args>({
    name: config.name,
    description: formatApprovalRequiredDescription(config.description),
    ...(config.tags ? { tags: config.tags } : {}),
    parameters: config.parameters,
    riskLevel,
    validate: validator,
    approvalExecuteToolName: executeToolName,
    handler: (args: Args, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const approvalResult = yield* config.approvalMessage(args, context);
        // Support both string and structured { message, previewDiff } return types
        const message =
          typeof approvalResult === "string" ? approvalResult : approvalResult.message;
        const previewDiff =
          typeof approvalResult === "string" ? undefined : approvalResult.previewDiff;
        return {
          success: false,
          result: {
            approvalRequired: true,
            message,
            previewDiff,
            executeToolName: executeToolName,
            executeArgs: args as Record<string, unknown>,
          },
          error: errorMessage,
        } as ToolExecutionResult;
      }),
  });

  // Create the execution tool (hidden, called by system)
  const executionTool = defineTool<R, Args>({
    name: executeToolName,
    description: formatExecutionToolDescription(
      `Performs the actual ${config.name} operation after user approval. This tool should only be called by the system after approval.`,
    ),
    hidden: true,
    riskLevel,
    parameters: config.parameters,
    validate: validator,
    handler: config.handler,
    ...(config.createSummary ? { createSummary: config.createSummary } : {}),
  });

  return {
    approval: approvalTool,
    execute: executionTool,
    all: () => [approvalTool, executionTool] as const,
  };
}
