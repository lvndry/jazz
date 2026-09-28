import { Context, Effect } from "effect";
import type { KnownSecret } from "@/core/secrets/redaction";
import type { AppConfig } from "@/core/types/index";

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
  /** Monotonic config revision. Increments on each successful mutation. */
  readonly revision: Effect.Effect<number, never>;
  /** Gets the complete application configuration. */
  readonly appConfig: Effect.Effect<AppConfig, never>;
  /**
   * Whether the last `set` of this secret had nowhere to go — no keyring, and no structural
   * home in the config file. Lets a command report that instead of claiming success.
   */
  readonly secretStorageUnavailable: (key: string) => boolean;
  /**
   * Every secret value Jazz holds, for replacing in tool output: the config's own secrets and
   * those kept only in the keyring or the environment (peer and webhook tokens, notify target
   * secrets, the daemon's tokens), plus secret-named environment variables. A service without
   * it has only the secrets in `appConfig`.
   */
  readonly knownSecrets?: Effect.Effect<readonly KnownSecret[], never>;
  /** Re-read the config file when another process has changed it. */
  readonly reloadIfChanged: () => Effect.Effect<boolean, never>;
}

export const AgentConfigServiceTag = Context.GenericTag<AgentConfigService>("AgentConfigService");
