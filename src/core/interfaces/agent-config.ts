import { Context, Effect } from "effect";
import type { AppConfig } from "../types/index";

export interface AgentConfigService {
  /** Gets a config value by key. Returns the typed value or fails if not found. */
  readonly get: <A>(key: string) => Effect.Effect<A, never>;
  /** Gets a config value by key, or returns the fallback if not found. */
  readonly getOrElse: <A>(key: string, fallback: A) => Effect.Effect<A, never>;
  /** Gets a config value by key, or fails with an error if not found. */
  readonly getOrFail: <A>(key: string) => Effect.Effect<A, never>;
  /** Checks if a config key exists. */
  readonly has: (key: string) => Effect.Effect<boolean, never>;
  /** Sets a config value for the given key. */
  readonly set: <A>(key: string, value: A) => Effect.Effect<void, never>;
  /** Gets the complete application configuration. */
  readonly appConfig: Effect.Effect<AppConfig, never>;
}

export const AgentConfigServiceTag = Context.GenericTag<AgentConfigService>("AgentConfigService");
