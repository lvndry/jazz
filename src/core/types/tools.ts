import type z from "zod";

// Re-export ToolRiskLevel from tool-registry interface
export type { ToolRiskLevel } from "@/core/interfaces/tool-registry";

/**
 * Auto-approve policy for workflow execution.
 *
 * - `false` or undefined: No auto-approve, always prompt user
 * - `true` or `"high-risk"`: Auto-approve all tools (including high-risk)
 * - `"low-risk"`: Auto-approve read-only and low-risk tools, prompt for high-risk
 * - `"read-only"`: Auto-approve only read-only tools, prompt for low-risk and high-risk
 */
export type AutoApprovePolicy = boolean | "read-only" | "low-risk" | "high-risk";

/**
 * Check if a tool's risk level should be auto-approved given a policy.
 */
export function shouldAutoApprove(
  riskLevel: import("@/core/interfaces/tool-registry").ToolRiskLevel,
  policy: AutoApprovePolicy | undefined,
): boolean {
  if (!policy) return false;

  // true or "high-risk" means approve everything
  if (policy === true || policy === "high-risk") return true;

  // "low-risk" approves read-only and low-risk
  if (policy === "low-risk") {
    return riskLevel === "read-only" || riskLevel === "low-risk";
  }

  // "read-only" only approves read-only tools
  if (policy === "read-only") {
    return riskLevel === "read-only";
  }

  return false;
}

/**
 * Tool/Function calling types
 */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: z.ZodTypeAny;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  /**
   * Google Gemini thought_signature - encrypted representation of model's
   * internal reasoning. Must be preserved when present to maintain context.
   */
  thought_signature?: string;
}

export interface ToolCallResult {
  toolCallId: string;
  role: "tool";
  name: string;
  content: string;
}

export interface ToolExecutionResult {
  readonly success: boolean;
  readonly result: unknown;
  readonly error?: string;
}

/**
 * Result structure when a tool requires user approval before execution.
 * Returned by approval tools created with `defineApprovalTool`.
 */
export interface ApprovalRequiredResult {
  readonly approvalRequired: true;
  /** Human-readable message explaining what will happen if approved */
  readonly message: string;
  /** The name of the tool to execute after approval */
  readonly executeToolName: string;
  /** The arguments to pass to the execution tool */
  readonly executeArgs: Record<string, unknown>;
}

/**
 * Request structure for approval prompts shown to the user
 */
export interface ApprovalRequest {
  /** The name of the tool requesting approval */
  readonly toolName: string;
  /** Human-readable description of the action */
  readonly message: string;
  /** The execution tool that will be called on approval */
  readonly executeToolName: string;
  /** Arguments that will be passed to the execution tool */
  readonly executeArgs: Record<string, unknown>;
}

/**
 * Result of a user approval decision.
 * When rejected, the user may optionally provide a message to guide the agent (e.g. "Don't bump version, do X instead").
 */
export type ApprovalOutcome =
  | { readonly approved: true }
  | { readonly approved: false; readonly userMessage?: string };

/**
 * Type guard to check if a tool result requires approval
 */
export function isApprovalRequiredResult(
  result: unknown,
): result is ApprovalRequiredResult {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return (
    r["approvalRequired"] === true &&
    typeof r["message"] === "string" &&
    typeof r["executeToolName"] === "string" &&
    typeof r["executeArgs"] === "object" &&
    r["executeArgs"] !== null
  );
}

export interface ToolCategory {
  readonly id: string;
  readonly displayName: string;
}

export interface ToolExecutionContext {
  readonly agentId: string;
  readonly conversationId?: string;
  /**
   * Auto-approve policy for this execution context.
   * When set, tools matching the policy will be auto-approved without user interaction.
   */
  readonly autoApprovePolicy?: AutoApprovePolicy;
  readonly [key: string]: unknown;
}
