import { Effect } from "effect";
import { z } from "zod";
import type { Tool, ToolDisclosure, ToolRiskLevel } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";

/**
 * Shared builders for Jazz tools.
 *
 * `defineTool` always validates arguments against the supplied Zod schema.
 * `defineApprovalTool` creates the visible proposal tool and the hidden
 * `execute_*` counterpart used after approval.
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
   * One-line summary for a `deferred`-tier tool, falling back to a truncated `description`.
   *
   * This is the only text `search_tools` matches, and matching is literal token overlap, so it
   * has to carry the words a request would use rather than the ones the implementation uses.
   */
  readonly summary?: string;
  /**
   * Optional array of tags for categorizing and organizing tools.
   */
  readonly tags?: readonly string[];
  /** Alternative names the LLM may use to call this tool. */
  readonly aliases?: readonly string[];
  /**
   * Zod schema defining the structure and validation rules for tool arguments.
   */
  readonly parameters: z.ZodTypeAny;
  /**
   * Original JSON Schema to advertise to the model when Zod conversion would be
   * lossy (MCP tools). When set, this is what the provider sees.
   */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  /** If true, hide this tool from UI listings while keeping it callable. */
  readonly hidden?: boolean;
  /**
   * Risk level for auto-approval in workflows.
   * Defaults to "read-only" for regular tools, "high-risk" for approval tools.
   */
  readonly riskLevel?: ToolRiskLevel;
  /** What an answer from this tool reveals about the operator. No default: decide. */
  readonly disclosure: ToolDisclosure;
  /**
   * Optional validator. When omitted, arguments are checked with
   * {@link makeZodValidator} against `parameters`.
   *
   * `parameters` is therefore an enforced gate, not just the schema shown to
   * the model: the handler receives the *parsed* value, so a plain `z.object`
   * drops any key it does not name. Tools whose schema is derived from an
   * external source (MCP, custom tools) should pass an explicit validator
   * rather than let a lossy conversion reject or empty valid calls.
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
 * Define a tool that validates arguments before calling `handler`.
 *
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
    ...(config.summary !== undefined ? { summary: config.summary } : {}),
    tags: config.tags ?? [],
    ...(config.aliases ? { aliases: config.aliases } : {}),
    parameters: config.parameters,
    ...(config.jsonSchema !== undefined ? { jsonSchema: config.jsonSchema } : {}),
    hidden: config.hidden === true,
    riskLevel: config.riskLevel ?? defaultRiskLevel,
    disclosure: config.disclosure,
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
      const validator = config.validate ?? makeZodValidator(config.parameters as z.ZodType<Args>);
      const result = validator(args);
      if (!result.valid) {
        const message = (result.errors || ["Invalid arguments"]).join("; ");
        return Effect.succeed({ success: false, result: null, error: message });
      }
      return config.handler(result.value as Args, context);
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
  /** One-line summary `search_tools` matches. See {@link BaseToolConfig.summary}. */
  readonly summary?: string;
  /** Optional tags for categorization */
  readonly tags?: readonly string[];
  /** Zod schema for parameters */
  readonly parameters: z.ZodTypeAny;
  /**
   * Risk level for auto-approval in workflows.
   * Defaults to "high-risk" for approval tools.
   */
  readonly riskLevel?: ToolRiskLevel;
  /** What an answer from this tool reveals about the operator. No default: decide. */
  readonly disclosure: ToolDisclosure;
  /** Optional custom validator */
  readonly validate?: ToolValidator<Args>;
  /**
   * Generate the approval message shown to the user.
   *
   * Return types:
   * - `string` — simple approval message
   * - `{ message, previewDiff? }` — approval message with optional diff preview
   * - `{ skipApproval: true, toolResult }` — bypass approval and return result directly to the LLM
   *   (use when pre-validation detects the edit will fail, e.g., pattern not found)
   */
  readonly approvalMessage: (
    args: Args,
    context: ToolExecutionContext,
  ) => Effect.Effect<
    | string
    | { message: string; previewDiff?: string }
    | { skipApproval: true; toolResult: ToolExecutionResult },
    Error,
    R
  >;
  /** Custom error message when approval is required */
  readonly approvalErrorMessage?: string;
  /** The actual execution handler (runs after approval) */
  readonly handler: (
    args: Args,
    context: ToolExecutionContext,
  ) => Effect.Effect<ToolExecutionResult, Error, R>;
  /** Optional summary generator */
  readonly createSummary?: (result: ToolExecutionResult) => string | undefined;
  /**
   * Custom timeout in milliseconds for the execution tool.
   * Overrides the default 3-minute executor timeout.
   */
  readonly timeoutMs?: number;
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
 */
export function defineApprovalTool<R, Args extends Record<string, unknown>>(
  config: ApprovalToolConfig<R, Args>,
): ApprovalToolPair<R> {
  const executeToolName = `execute_${config.name}`;
  const riskLevel = config.riskLevel ?? "high-risk";

  const validator: ToolValidator<Args> =
    config.validate ?? makeZodValidator(config.parameters as z.ZodType<Args>);

  const errorMessage =
    config.approvalErrorMessage ?? `Approval required: ${config.name} requires user confirmation.`;

  // Create the approval tool (shown to LLM)
  const approvalTool = defineTool<R, Args>({
    name: config.name,
    description: config.description,
    ...(config.summary !== undefined ? { summary: config.summary } : {}),
    ...(config.tags ? { tags: config.tags } : {}),
    parameters: config.parameters,
    riskLevel,
    disclosure: config.disclosure,
    validate: validator,
    approvalExecuteToolName: executeToolName,
    handler: (args: Args, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const approvalResult = yield* config.approvalMessage(args, context);

        // Early return: bypass approval and send result directly back to the LLM
        if (typeof approvalResult === "object" && "skipApproval" in approvalResult) {
          return approvalResult.toolResult;
        }

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
        };
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
    disclosure: config.disclosure,
    parameters: config.parameters,
    validate: validator,
    handler: config.handler,
    ...(config.createSummary ? { createSummary: config.createSummary } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });

  return {
    approval: approvalTool,
    execute: executionTool,
    all: () => [approvalTool, executionTool] as const,
  };
}
