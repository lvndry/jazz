import type { Agent } from "@/core/types";
import type { ChatMessage } from "@/core/types/message";
import type { AutoApprovePolicy } from "@/core/types/tools";

/**
 * Types of special commands available in the chat interface
 */
export type CommandType =
  | "new"
  | "help"
  | "clear"
  | "tools"
  | "agents"
  | "switch"
  | "compact"
  | "copy"
  | "model"
  | "config"
  | "skills"
  | "context"
  | "cost"
  | "workflows"
  | "stats"
  | "mcp"
  | "mode"
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
}

/** Token usage accumulated for the current conversation (for /cost). */
export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Context needed to execute a command
 */
export interface CommandContext {
  agent: Agent;
  conversationId: string | undefined;
  conversationHistory: ChatMessage[];
  sessionId: string;
  /** Accumulated input/output tokens for this session (reset on /new). */
  sessionUsage: SessionUsage;
  /** Timestamp when the chat session started (for /stats duration). */
  sessionStartedAt: Date;
  /** Current auto-approve policy (for /mode display). */
  autoApprovePolicy?: AutoApprovePolicy;
  /** Currently auto-approved command prefixes (for /mode display). */
  autoApprovedCommands?: readonly string[];
  /** Commands persisted in config (always auto-approved across sessions). */
  persistedAutoApprovedCommands?: readonly string[];
}
