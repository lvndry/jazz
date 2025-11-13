import { Effect } from "effect";
import { z } from "zod";
import {
  type Tool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRoutingMetadata,
} from "./tool-registry";

const TOKEN_SPLIT_REGEX = /[^a-z0-9]+/gi;

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));
}

function splitIdentifier(identifier: string): readonly string[] {
  const withSpaces = identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return uniqueStrings([identifier, ...withSpaces.split(/\s+/)]);
}

function tokenize(text: string, limit = 24): readonly string[] {
  const lowered = text.toLowerCase();
  const parts = lowered.split(TOKEN_SPLIT_REGEX);
  const filtered = parts.filter((part) => part.length > 1 || part === "cd");
  return uniqueStrings(filtered).slice(0, limit);
}

function buildRoutingMetadata(
  name: string,
  description: string,
  custom?: ToolRoutingMetadata,
): ToolRoutingMetadata {
  const nameKeywords = splitIdentifier(name);
  const descriptionTokens = tokenize(description);

  const tags = uniqueStrings([...(custom?.tags ?? [])]);
  const keywords = uniqueStrings([
    ...nameKeywords,
    ...descriptionTokens,
    ...(custom?.keywords ?? []),
  ]);
  const examples = uniqueStrings([...(custom?.examples ?? [])]);
  const priority = custom?.priority;

  return {
    tags,
    keywords,
    ...(examples.length > 0 ? { examples } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
}

/**
 * Lightweight, reusable tool builder with optional runtime validation.
 * Keeps JSON Schema as-is for LLMs and applies a simple validator at runtime.
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
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodTypeAny;
  /** If true, hide this tool from UI listings while keeping it callable. */
  readonly hidden?: boolean;
  /**
   * Optional routing metadata to help the agent decide when to use this tool.
   * Tags and keywords are merged with intelligent defaults, so you can provide
   * only the extra hints that matter.
   */
  readonly routing?: ToolRoutingMetadata;
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
  const routing = buildRoutingMetadata(config.name, config.description, config.routing);

  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    hidden: config.hidden === true,
    routing,
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
                      instruction: `Please ask the user for confirmation. If they confirm, call this tool again with { "confirm": true } or call: ${execute.toolName} with these exact arguments: ${JSON.stringify(execute.buildArgs(validated))}`,
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
 * Build a minimal runtime validator from a JSON Schema subset.
 * Supports: type = string|number|boolean|array(object: items.type), required[], additionalProperties.
 */
export function makeJsonSchemaValidator<Args extends Record<string, unknown>>(
  schema: Record<string, unknown>,
): ToolValidator<Args> {
  return (args: Record<string, unknown>) => {
    const errors: string[] = [];

    const s = schema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };

    if (s.type !== undefined && s.type !== "object") {
      errors.push("Root schema.type must be 'object'");
    }

    const properties = (s.properties || {}) as Record<
      string,
      { type?: string; items?: { type?: string } }
    >;
    const required = new Set((s.required || []) as string[]);

    for (const key of required) {
      if (!(key in args)) {
        errors.push(`Missing required property: ${key}`);
      }
    }

    for (const [key, value] of Object.entries(args)) {
      const prop = properties[key];
      if (!prop) {
        if (s.additionalProperties === false) {
          errors.push(`Unknown property: ${key}`);
        }
        continue;
      }
      const expected = prop.type;
      if (!expected) continue;
      const actual = typeof value;
      if (expected === "array") {
        if (!Array.isArray(value)) {
          errors.push(`Property '${key}' expected array, got ${actual}`);
        } else {
          const itemType = prop.items?.type;
          if (itemType) {
            for (let i = 0; i < value.length; i++) {
              const t = typeof (value as unknown[])[i];
              if (t !== itemType) {
                errors.push(`Property '${key}[${i}]' expected ${itemType}, got ${t}`);
              }
            }
          }
        }
      } else if (actual !== expected) {
        errors.push(`Property '${key}' expected ${expected}, got ${actual}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors } as const;
    }

    return { valid: true, value: args as Args } as const;
  };
}

/**
 * Utility to extend a JSON schema object with a standard approval boolean field.
 * This does not mutate the original schema object.
 */
export function withApprovalBoolean(
  schema: z.ZodTypeAny,
  options?: { fieldName?: string; description?: string },
): z.ZodTypeAny {
  const fieldName = options?.fieldName ?? "confirm";
  const description = options?.description ?? "Set to true to confirm this action.";

  // If provided a Zod object, extend it in-place with a boolean confirm field
  if (schema instanceof z.ZodObject) {
    return schema.extend({
      [fieldName]: z.boolean().describe(description),
    });
  }
  // If it's some other Zod type, intersect with an object carrying confirm
  return z.object({ [fieldName]: z.boolean().describe(description) }).and(schema);
}
