import { Effect } from "effect";
import type { AppConfig } from "../types/index";

export interface ConfigService {
  readonly get: <A>(key: string) => Effect.Effect<A, never>;
  readonly getOrElse: <A>(key: string, fallback: A) => Effect.Effect<A, never>;
  readonly getOrFail: <A>(key: string) => Effect.Effect<A, never>;
  readonly has: (key: string) => Effect.Effect<boolean, never>;
  readonly set: <A>(key: string, value: A) => Effect.Effect<void, never>;
  readonly appConfig: Effect.Effect<AppConfig, never>;
}
