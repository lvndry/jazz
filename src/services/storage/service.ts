import { Effect } from "effect";
import { StorageServiceTag, type StorageService } from "@/core/interfaces/storage";
import type { Agent } from "@/core/types";
import type { StorageError, StorageNotFoundError } from "@/core/types/errors";

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
