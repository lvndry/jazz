import type { Effect } from "effect";
import type z from "zod";
import type { ToolRiskLevel } from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types/agent";
import type { AttachmentKind, MessageAttachment } from "@/core/types/attachment";
import type { ChatMessage } from "@/core/types/message";
import type { StreamEvent } from "@/core/types/streaming";

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
  riskLevel: ToolRiskLevel,
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
  /** Correlates this request with its `tool_call.id`, so an external approver
   * (e.g. the Telegram bridge) can resolve the specific pending approval. */
  readonly toolCallId: string;
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
  /**
   * Optional callback to re-check auto-approve status at dequeue time.
   * Used by the approval queue to skip prompts for tools that were
   * auto-approved by a parallel tool's "always approve" choice while
   * waiting in the queue.
   */
  readonly isAutoApproved?: () => boolean;
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
  readonly model?: string;
  /**
   * Auto-approve policy getter for this execution context.
   * Returns the current policy, which may change mid-run via Shift+Tab toggle.
   * When set, tools matching the policy will be auto-approved without user interaction.
   */
  readonly getAutoApprovePolicy?: () => AutoApprovePolicy | undefined;
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
  /** Iteration budget for a sub-agent spawned here — its own, not the parent's remainder. */
  readonly maxSubagentIterations?: number;
  /**
   * The parent's effective tool names. `spawn_subagent` passes these down as
   * the child's allowlist so a child can never hold a tool its parent lacks.
   */
  readonly parentToolNames?: readonly string[];
  /**
   * How many sub-agent levels sit above the run executing this tool. 0 at the
   * top level; `spawn_subagent` increments it and refuses past the limit.
   */
  readonly subagentDepth?: number;
  /** Nesting limit for this run, resolved once by the runner so a whole tree agrees. */
  readonly maxSubagentDepth?: number;
  /**
   * Callback to replace conversation messages with compacted versions.
   * Used by summarize_context to actually update the executor's message array.
   */
  readonly compactConversation?: (compacted: readonly ChatMessage[]) => void;
  /**
   * Attach a media file (image/pdf/audio/video) to the current turn so the model actually
   * receives its contents on the next request.
   *
   * Needed because tool results are text-only: `read_file` on a screenshot can describe the
   * file but cannot put pixels into a `role: "tool"` message. The executor collects whatever
   * tools register here and emits it as a following user message, which every provider accepts
   * as a carrier for file parts.
   *
   * Undefined when the executor has no way to extend the message list (one-shot tool calls,
   * some test harnesses); tools must fall back to describing the file in text.
   */
  readonly attachMedia?: (attachment: MessageAttachment) => void;
  /**
   * Attachment modalities the active model accepts, from its models.dev capabilities.
   *
   * Tools check this before calling `attachMedia` so they can fail loudly rather than send an
   * image to a text-only model — which is a provider error, not a degraded answer.
   */
  readonly supportedAttachmentKinds?: readonly AttachmentKind[];
  /**
   * Record the USD cost of a nested run (e.g. a sub-agent spawned via
   * spawn_subagent) against the parent run. The parent's finalized costUSD
   * adds this so aggregated pricing reflects all sub-agent spend, not just
   * the orchestrator's own tokens.
   */
  readonly recordChildCost?: (costUSD: number) => void;
  /**
   * Commands that are always auto-approved for execute_command tool.
   * Each entry is a prefix — a command is approved if it starts with any entry.
   */
  readonly autoApprovedCommands?: readonly string[];
  /**
   * Callback invoked when the user chooses "always approve" for a specific command.
   * The chat service uses this to add the command to the auto-approved list and
   * persist the approval for cross-session promotion.
   */
  readonly onAutoApproveCommand?: (command: string) => Effect.Effect<void>;
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
  /**
   * Emit a live stream event from within a tool — e.g. spawn_subagent emitting
   * subagent_start/complete, or any long-running tool reporting progress.
   * Wired to the executor's streaming renderer when one exists; undefined in
   * non-streaming contexts. Lets tools surface live progress to `--events`
   * consumers without holding a renderer reference themselves.
   */
  readonly emitEvent?: (event: StreamEvent) => Effect.Effect<void, never>;
  /**
   * IANA timezone (e.g. "Europe/Paris") for this run, threaded from the CLI's
   * `--timezone` flag or a surface-specific caller (e.g. the Telegram bridge
   * passing a per-chat zone). Not LLM-facing — tools that need "now" in the
   * caller's local time (e.g. add_reminder) read this directly rather than
   * asking the model to supply a timezone string. Defaults to "UTC" when unset.
   */
  readonly timezone?: string;
  readonly [key: string]: unknown;
}
