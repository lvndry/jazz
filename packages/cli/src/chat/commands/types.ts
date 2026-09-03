/**
 * Shared types for chat slash-command parsing, dispatch, and results.
 */

import type { Agent } from "@jazz/core/types";
import type { ChatMessage } from "@jazz/core/types/message";
import type { AutoApprovePolicy } from "@jazz/core/types/tools";

/**
 * Types of special commands available in the chat interface
 */
export type CommandType =
  | "new"
  | "fork"
  | "help"
  | "clear"
  | "tools"
  | "agents"
  | "peers"
  | "switch"
  | "compact"
  | "copy"
  | "reasoning"
  | "config"
  | "skills"
  | "context"
  | "work"
  | "cost"
  | "workflows"
  | "stats"
  | "mcp"
  | "mode"
  | "resume"
  | "theme"
  | "export"
  | "retry"
  | "shell"
  | "limit"
  | "runSkill"
  | "runMcpPrompt"
  | "unknown";

/**
 * Parsed special command from user input
 */
export interface SpecialCommand {
  type: CommandType;
  args: string[];
}

/**
 * Result of executing a special command
 */
export interface CommandResult {
  /** Whether the chat loop should continue */
  shouldContinue: boolean;
  /** New conversation ID if conversation was reset/changed */
  newConversationId?: string;
  /** New conversation history if history was modified */
  newHistory?: ChatMessage[];
  /** New agent if agent was switched */
  newAgent?: Agent;
  /** New auto-approve policy for tool calls (set by /mode command) */
  newAutoApprovePolicy?: AutoApprovePolicy | false;
  /** Command prefix to add to auto-approved commands list */
  addAutoApprovedCommand?: string;
  /** Command prefix to remove from auto-approved commands list */
  removeAutoApprovedCommand?: string;
  /** Save current conversation history before resetting state */
  saveCurrentHistory?: boolean;
  /** Reset the startedAt timestamp to now (used when resuming a saved conversation) */
  resetStartedAt?: boolean;
  /** Message to re-send to the agent immediately (set by /retry) */
  resendMessage?: string;
  /** Message to send to the agent after a user-side command has completed. */
  messageForAgent?: string;
  /** New session-wide limits set by /limit (a full replacement, not a patch — an absent field means "no limit"). */
  newSessionLimits?: SessionLimits;
}

/** Token usage accumulated for the current conversation (for /cost). */
export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Session-wide caps set by /limit. Checked against this conversation's
 * accumulated usage (the same numbers /cost and /stats show) before every
 * turn; an absent field means that metric is uncapped.
 */
export interface SessionLimits {
  /** Max number of turns (user messages sent to the agent) for this conversation. */
  maxTurns?: number;
  /** Max cumulative estimated USD spend for this conversation. */
  maxCostUSD?: number;
  /** Max cumulative tokens (prompt + completion) for this conversation. */
  maxTokens?: number;
}

/**
 * Context needed to execute a command
 */
export interface CommandContext {
  agent: Agent;
  conversationId: string;
  conversationHistory: ChatMessage[];
  /** Accumulated input/output tokens for this session (reset on /new). */
  sessionUsage: SessionUsage;
  /** Number of turns sent to the agent this conversation (reset on /new, for /limit). */
  sessionTurnCount: number;
  /** Session-wide turn/cost/token caps set by /limit (persists across /new). */
  sessionLimits: SessionLimits;
  /** Timestamp when the chat session started (for /stats duration). */
  sessionStartedAt: Date;
  /** Current auto-approve policy (for /mode display). */
  autoApprovePolicy?: AutoApprovePolicy;
  /** Currently auto-approved command prefixes (for /mode display). */
  autoApprovedCommands?: readonly string[];
  /** Commands persisted in config (always auto-approved across sessions). */
  persistedAutoApprovedCommands?: readonly string[];
  /** Currently auto-approved tool names for this session (for /mode display). */
  autoApprovedTools?: readonly string[];
  /** ID of the agent most recently chatted with, used to sort /agents and /switch. */
  lastUsedAgentId?: string | null;
}
