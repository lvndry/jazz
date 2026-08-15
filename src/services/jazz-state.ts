import { FileSystem } from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  JazzStateServiceTag,
  type JazzState,
  type JazzStateService,
} from "@/core/interfaces/jazz-state";
import { safeParseJson } from "@/core/utils/json";
import { getJazzHomeDirectory } from "@/core/utils/paths";

export function createJazzStateServiceLayer(): Layer.Layer<
  JazzStateService,
  never,
  FileSystem.FileSystem
> {
  return Layer.effect(
    JazzStateServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const statePath = `${getJazzHomeDirectory()}/state.json`;
      let state: JazzState = {};

      function ensureStateDir(): Effect.Effect<void, never> {
        return Effect.gen(function* () {
          const dir = statePath.substring(0, statePath.lastIndexOf("/"));
          yield* fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.catchAll(() => Effect.void));
        });
      }

      function loadState(): Effect.Effect<void, never> {
        return Effect.gen(function* () {
          const exists = yield* fs
            .exists(statePath)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (!exists) {
            state = {};
            return;
          }
          const content = yield* fs
            .readFileString(statePath)
            .pipe(Effect.catchAll(() => Effect.succeed("{}")));
          const parsed = safeParseJson<JazzState>(content);
          if (
            parsed._tag === "Some" &&
            parsed.value &&
            typeof parsed.value === "object" &&
            !Array.isArray(parsed.value)
          ) {
            state = parsed.value;
          } else {
            state = {};
          }
        });
      }

      yield* loadState();

      return {
        get: <A>(key: string): Effect.Effect<A | undefined, never> =>
          Effect.sync(() => deepGet(state as Record<string, unknown>, key) as A | undefined),

        set: <A>(key: string, value: A): Effect.Effect<void, never> =>
          Effect.gen(function* () {
            deepSet(state as Record<string, unknown>, key, value);
            yield* ensureStateDir();
            yield* fs
              .writeFileString(statePath, JSON.stringify(state, null, 2))
              .pipe(Effect.catchAll(() => Effect.void));
          }),

        load: (): Effect.Effect<JazzState, never> => Effect.sync(() => state),

        persist: (): Effect.Effect<void, never> =>
          Effect.gen(function* () {
            yield* ensureStateDir();
            yield* fs
              .writeFileString(statePath, JSON.stringify(state, null, 2))
              .pipe(Effect.catchAll(() => Effect.void));
          }),
      };
    }),
  );
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepGet(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) {
      return undefined;
    }
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i] as string;
    if (FORBIDDEN_KEYS.has(key)) {
      return;
    }
    if (i === parts.length - 1) {
      current[key] = value;
    } else {
      const next = current[key];
      if (!next || typeof next !== "object") {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
  }
}
