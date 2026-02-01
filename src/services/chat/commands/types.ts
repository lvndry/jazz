import type { Agent } from "@/core/types";
import type { ChatMessage } from "@/core/types/message";

/**
 * Types of special commands available in the chat interface
 */
export type CommandType =
  | "new"
  | "help"
  | "status"
  | "clear"
  | "tools"
  | "agents"
  | "switch"
  | "compact"
  | "copy"
  | "skills"
  | "context"
  | "cost"
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
}
