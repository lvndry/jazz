/**
 * `ChatService` interface for running an interactive chat session loop
 * between a user and an agent.
 */
import type { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";
import type { SkillService } from "@/core/skills/skill-service";
import type { Agent } from "@/core/types/index";
import type { ChatMessage } from "@/core/types/message";
import type { WorkflowService } from "@/core/workflows/workflow-service";
import { AgentConfigServiceTag } from "./agent-config";
import type { AgentService } from "./agent-service";
import type { FileSystemContextService } from "./fs";
import type { JazzStateService } from "./jazz-state";
import type { LLMService } from "./llm";
import type { LoggerService } from "./logger";
import type { PersonaService } from "./persona-service";
import type { PresentationService } from "./presentation";
import type { TerminalService } from "./terminal";
import type { ToolRegistry, ToolRequirements } from "./tool-registry";

/** How a chat session ended, so the command can pick its exit code. */
export interface ChatSessionEnd {
  /**
   * `exit` when the user left (`/exit`, a command that ends the chat, or a
   * failure). `end-of-input` when a non-interactive terminal ran out of stdin.
   */
  readonly reason: "exit" | "end-of-input";
  /** Messages and commands the session received from the user. */
  readonly messagesReceived: number;
}

/**
 * Chat service interface for managing chat sessions with AI agents
 *
 * Provides methods for starting and managing interactive chat sessions with agents.
 * Handles session initialization, message logging, and conversation flow.
 */
export interface ChatService {
  /**
   * Start an interactive chat loop with an AI agent
   *
   * Creates a new chat session, initializes logging, and runs an interactive loop
   * where users can chat with the agent. The session persists until the user exits.
   *
   * @param agent - The agent to chat with
   * @param options - Optional configuration for the chat session
   * @returns An Effect that resolves with how the session ended
   */
  readonly startChatSession: (
    agent: Agent,
    options?: {
      stream?: boolean;
      initialHistory?: ChatMessage[];
      maxIterations?: number;
      /**
       * Skip persistence for this session entirely: no conversation history
       * save (on /new or exit), no per-message session log, and the
       * `manage_memory` tool is withheld. File tools and telemetry are separate
       * and retain their normal behavior. Mirrors `jazz run --ephemeral`.
       */
      ephemeral?: boolean;
    },
  ) => Effect.Effect<
    ChatSessionEnd,
    never,
    | TerminalService
    | LoggerService
    | FileSystemContextService
    | FileSystem.FileSystem
    | typeof AgentConfigServiceTag
    | JazzStateService
    | ToolRegistry
    | AgentService
    | LLMService
    | PresentationService
    | ToolRequirements
    | SkillService
    | WorkflowService
    | PersonaService
  >;
}

export const ChatServiceTag = Context.GenericTag<ChatService>("ChatService");
