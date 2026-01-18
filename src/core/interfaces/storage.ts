import { Context, Effect } from "effect";
import type { Agent } from "../types";
import type { StorageError, StorageNotFoundError } from "@/core/types/errors";

/**
 * Storage service interface for managing agent persistence
 *
 * Provides methods for saving, retrieving, listing, and deleting agents
 * from persistent storage. All operations are wrapped in Effect for
 * proper error handling and dependency injection.
 */
export interface StorageService {
  /**
   * Save an agent to storage
   * @param agent - The agent to save
   * @returns An Effect that resolves when the agent is saved
   */
  readonly saveAgent: (agent: Agent) => Effect.Effect<void, StorageError>;

  /**
   * Retrieve an agent by ID
   * @param id - The unique identifier of the agent
   * @returns An Effect that resolves to the agent, or fails with StorageNotFoundError if not found
   */
  readonly getAgent: (id: string) => Effect.Effect<Agent, StorageError | StorageNotFoundError>;

  /**
   * List all stored agents
   * @returns An Effect that resolves to an array of all agents
   */
  readonly listAgents: () => Effect.Effect<readonly Agent[], StorageError>;

  /**
   * Delete an agent from storage
   * @param id - The unique identifier of the agent to delete
   * @returns An Effect that resolves when the agent is deleted, or fails with StorageNotFoundError if not found
   */
  readonly deleteAgent: (id: string) => Effect.Effect<void, StorageError | StorageNotFoundError>;
}

export const StorageServiceTag = Context.GenericTag<StorageService>("StorageService");
