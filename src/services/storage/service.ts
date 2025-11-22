import { Context, Effect } from "effect";

import type { Agent } from "../../core/types";

import type { StorageError, StorageNotFoundError } from "../../core/types/errors";

export interface StorageService {
  readonly saveAgent: (agent: Agent) => Effect.Effect<void, StorageError>;
  readonly getAgent: (id: string) => Effect.Effect<Agent, StorageError | StorageNotFoundError>;
  readonly listAgents: () => Effect.Effect<readonly Agent[], StorageError>;
  readonly deleteAgent: (id: string) => Effect.Effect<void, StorageError | StorageNotFoundError>;
}

export const StorageServiceTag = Context.GenericTag<StorageService>("StorageService");

export function saveAgent(agent: Agent): Effect.Effect<void, StorageError, StorageService> {
  return Effect.gen(function* () {
    const storage = yield* StorageServiceTag;
    yield* storage.saveAgent(agent);
  });
}

export function getAgent(
  id: string,
): Effect.Effect<Agent, StorageError | StorageNotFoundError, StorageService> {
  return Effect.gen(function* () {
    const storage = yield* StorageServiceTag;
    return yield* storage.getAgent(id);
  });
}

export function listAgents(): Effect.Effect<readonly Agent[], StorageError, StorageService> {
  return Effect.gen(function* () {
    const storage = yield* StorageServiceTag;
    return yield* storage.listAgents();
  });
}
