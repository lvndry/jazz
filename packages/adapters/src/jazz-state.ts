/**
 * Implements `JazzStateService`: small persistent key-value state (e.g. "have I shown this
 * prompt before") stored at `$JAZZ_HOME/state.json`, distinct from user-facing config.
 *
 * Every `set` is a locked read-modify-write of the file, so two Jazz processes setting different
 * keys both land, and the file is replaced durably. A corrupt file is quarantined rather than
 * overwritten. Write failures reach the caller.
 */

import * as path from "node:path";
import {
  JazzStateServiceTag,
  type JazzState,
  type JazzStateService,
} from "@jazz/core/interfaces/jazz-state";
import { isRecord } from "@jazz/core/utils/is-record";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { readStateFile, type StateFileKind, writeStateFile } from "@jazz/core/utils/state-file";
import { withLock } from "@jazz/core/utils/storage";
import { Effect, Layer } from "effect";

const JAZZ_STATE_FILE_KIND: StateFileKind<Record<string, unknown>> = {
  noun: "Jazz state",
  schemaVersion: 1,
  parse: (document) => {
    if (!isRecord(document)) {
      return { ok: false, error: "expected an object" };
    }
    const { schemaVersion: _schemaVersion, ...state } = document;
    return { ok: true, content: state };
  },
  serialize: (state) => state,
};

export interface JazzStateServiceOptions {
  /** Override for tests; defaults to `$JAZZ_HOME/state.json`. */
  readonly statePath?: string;
}

export function createJazzStateServiceLayer(
  options: JazzStateServiceOptions = {},
): Layer.Layer<JazzStateService> {
  return Layer.effect(
    JazzStateServiceTag,
    Effect.gen(function* () {
      const statePath = options.statePath ?? path.join(getJazzHomeDirectory(), "state.json");
      const lockPath = `${statePath}.lock`;
      const readState = readStateFile(statePath, JAZZ_STATE_FILE_KIND, {
        onCorrupt: "quarantine",
      }).pipe(Effect.map((state) => state ?? {}));
      let state: Record<string, unknown> = yield* withLock(lockPath, readState).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error(`[jazz] ${statePath} could not be read: ${error.message}`);
            return {};
          }),
        ),
      );

      return {
        get: <A>(key: string): Effect.Effect<A | undefined, never> =>
          Effect.sync(() => deepGet(state, key) as A | undefined),

        set: <A>(key: string, value: A): Effect.Effect<void, Error> =>
          withLock(
            lockPath,
            Effect.gen(function* () {
              const current = yield* readState;
              deepSet(current, key, value);
              yield* writeStateFile(statePath, JAZZ_STATE_FILE_KIND, current);
              state = current;
            }),
          ),

        load: (): Effect.Effect<JazzState, never> => Effect.sync(() => state as JazzState),
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
