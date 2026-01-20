import type { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";
import type { SkillService } from "@/core/skills/skill-service";
import type { Agent } from "@/core/types/index";
import { AgentConfigServiceTag } from "./agent-config";
import type { AgentService } from "./agent-service";
import type { FileSystemContextService } from "./fs";
import type { LLMService } from "./llm";
import type { LoggerService } from "./logger";
import type { PresentationService } from "./presentation";
import type { TerminalService } from "./terminal";
import type { ToolRegistry, ToolRequirements } from "./tool-registry";

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
   * @returns An Effect that resolves when the chat session ends
   */
  readonly startChatSession: (
    agent: Agent,
    options?: {
      stream?: boolean;
    },
  ) => Effect.Effect<
    void,
    never,
    | TerminalService
    | LoggerService
    | FileSystemContextService
    | FileSystem.FileSystem
    | typeof AgentConfigServiceTag
    | ToolRegistry
    | AgentService
    | LLMService
    | PresentationService
    | ToolRequirements
    | SkillService
  >;
}

export const ChatServiceTag = Context.GenericTag<ChatService>("ChatService");
