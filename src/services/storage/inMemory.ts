import { Effect, Layer, Ref } from "effect";
import { StorageServiceTag, type StorageService } from "@/core/interfaces/storage";
import { StorageError, StorageNotFoundError } from "@/core/types/errors";
import type { Agent } from "@/core/types/index";

export class InMemoryStorageService implements StorageService {
  constructor(private readonly agents: Ref.Ref<Map<string, Agent>>) {}

  saveAgent(agent: Agent): Effect.Effect<void, StorageError> {
    return Ref.update(this.agents, (map) => new Map(map.set(agent.id, agent)));
  }

  getAgent(id: string): Effect.Effect<Agent, StorageError | StorageNotFoundError> {
    return Effect.flatMap(Ref.get(this.agents), (agents) => {
      const agent = agents.get(id);
      if (!agent) {
        return Effect.fail(new StorageNotFoundError({ path: `agent:${id}` }));
      }
      return Effect.succeed(agent);
    });
  }

  listAgents(): Effect.Effect<readonly Agent[], StorageError> {
    return Effect.map(Ref.get(this.agents), (agents) => Array.from(agents.values()));
  }

  deleteAgent(id: string): Effect.Effect<void, StorageError | StorageNotFoundError> {
    return Effect.flatMap(Ref.get(this.agents), (agents) => {
      if (!agents.has(id)) {
        return Effect.fail(new StorageNotFoundError({ path: `agent:${id}` }));
      }
      return Ref.update(this.agents, (map) => {
        const newMap = new Map(map);
        newMap.delete(id);
        return newMap;
      });
    });
  }
}

export function createInMemoryStorageLayer(): Layer.Layer<StorageService> {
  return Layer.effect(
    StorageServiceTag,
    Effect.gen(function* () {
      const agents = yield* Ref.make(new Map<string, Agent>());
      return new InMemoryStorageService(agents);
    }),
  );
}
