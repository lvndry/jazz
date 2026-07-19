import { Context, Effect } from "effect";

export interface JazzState {
  readonly wizard?: {
    readonly lastUsedAgentId?: string;
  };
}

export interface JazzStateService {
  /** Get a value from the runtime state by dot-notation key. */
  readonly get: <A>(key: string) => Effect.Effect<A | undefined, never>;
  /** Set a value in the runtime state by dot-notation key. */
  readonly set: <A>(key: string, value: A) => Effect.Effect<void, never>;
  /** Load the full runtime state. */
  readonly load: () => Effect.Effect<JazzState, never>;
  /** Persist the current runtime state. */
  readonly persist: () => Effect.Effect<void, never>;
}

export const JazzStateServiceTag = Context.GenericTag<JazzStateService>("JazzStateService");
