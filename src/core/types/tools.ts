import type z from "zod";
import type { Agent } from "@/core/types/agent";
import type { ChatMessage } from "@/core/types/message";

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
  /** Optional full diff preview for file edit operations (expandable with Ctrl+O) */
  readonly previewDiff?: string;
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
  /** Optional full diff preview for file edit operations (expandable with Ctrl+O) */
  readonly previewDiff?: string;
}

/**
 * Result of a user approval decision.
 * When rejected, the user may optionally provide a message to guide the agent (e.g. "Don't bump version, do X instead").
 */
export type ApprovalOutcome =
  | {
      readonly approved: true;
      readonly alwaysApproveCommand?: string;
      readonly alwaysApproveTool?: string;
    }
  | { readonly approved: false; readonly userMessage?: string };

/**
 * Type guard to check if a tool result requires approval
 */
export function isApprovalRequiredResult(result: unknown): result is ApprovalRequiredResult {
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
  readonly sessionId?: string;
  readonly conversationId?: string;
  /**
   * Auto-approve policy for this execution context.
   * When set, tools matching the policy will be auto-approved without user interaction.
   */
  readonly autoApprovePolicy?: AutoApprovePolicy;
  /**
   * Token usage statistics for context budget awareness.
   * Allows tools like context_info to report on current context usage.
   */
  readonly tokenStats?: {
    readonly currentTokens: number;
    readonly maxTokens: number;
  };
  /**
   * Current conversation messages, injected by executors.
   * Used by tools like summarize_context to access the full conversation.
   */
  readonly conversationMessages?: readonly ChatMessage[];
  /**
   * The parent agent running this tool execution.
   * Used by tools like spawn_subagent to inherit LLM configuration.
   */
  readonly parentAgent?: Agent;
  /**
   * Callback to replace conversation messages with compacted versions.
   * Used by summarize_context to actually update the executor's message array.
   */
  readonly compactConversation?: (compacted: readonly ChatMessage[]) => void;
  /**
   * Commands that are always auto-approved for execute_command tool.
   * Each entry is a prefix — a command is approved if it starts with any entry.
   */
  readonly autoApprovedCommands?: readonly string[];
  /**
   * Callback invoked when the user chooses "always approve" for a specific command.
   * The chat service uses this to add the command to the auto-approved list.
   */
  readonly onAutoApproveCommand?: (command: string) => void;
  /**
   * Tool names that are always auto-approved for this session.
   * When a tool name appears in this list, it will be auto-approved without prompting.
   */
  readonly autoApprovedTools?: readonly string[];
  /**
   * Callback invoked when the user chooses "always approve" for a specific tool.
   * The chat service uses this to add the tool to the auto-approved list.
   */
  readonly onAutoApproveTool?: (toolName: string) => void;
  readonly [key: string]: unknown;
}
