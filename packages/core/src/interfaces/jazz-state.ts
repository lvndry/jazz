import { Context, Effect } from "effect";

export interface JazzState {
  readonly wizard?: {
    readonly lastUsedAgentId?: string;
  };
}

export interface JazzStateService {
  /** Get a value from the runtime state by dot-notation key. */
  readonly get: <A>(key: string) => Effect.Effect<A | undefined, never>;
  /** Set a value by dot-notation key and store it; fails when the state file cannot be written. */
  readonly set: <A>(key: string, value: A) => Effect.Effect<void, Error>;
  /** Load the full runtime state. */
  readonly load: () => Effect.Effect<JazzState, never>;
}

export const JazzStateServiceTag = Context.GenericTag<JazzStateService>("JazzStateService");
