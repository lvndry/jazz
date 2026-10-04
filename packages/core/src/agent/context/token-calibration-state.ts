/**
 * Cross-run persistence for token-counter calibration.
 *
 * {@link TokenCounter} learns, after every LLM response, the provider's true
 * chars-per-token ratio and per-request overhead for each model. That learning
 * used to die with the process: a resumed session — where history is longest
 * and the first pre-call estimate is the most consequential one — started over
 * at family defaults. This module keeps a small, schema-versioned, atomically
 * written JSON file under the Jazz home directory so a fresh process starts
 * calibrated instead of guessing.
 *
 * The state is per-machine, not per-agent: the same model calibrates
 * identically wherever it is called from, so one file suffices.
 *
 * Both entry points degrade to the in-memory default on any failure — a disk
 * hiccup must never change what an agent counts or whether it runs:
 *   - at run start:  hydrateTokenCalibration()   (cannot fail)
 *   - after the first authoritative usage report of a run:
 *     saveTokenCalibration()   (returns the write Effect; the call site
 *     ignores it, since an unsaved calibration only costs the next run its
 *     first round trip)
 */

import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import { readStateFile, writeStateFile, type StateFileKind } from "@/core/utils/state-file";
import { DEFAULT_TOKEN_COUNTER, type CalibratedModel } from "./token-counter";

const FILE_NAME = "token-calibration.json";

interface TokenCalibrationState {
  readonly models: readonly CalibratedModel[];
}

function isCalibratedModel(value: unknown): value is CalibratedModel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["model"] === "string" &&
    typeof candidate["ratio"] === "number" &&
    Number.isFinite(candidate["ratio"]) &&
    typeof candidate["overhead"] === "number" &&
    Number.isFinite(candidate["overhead"])
  );
}

const TOKEN_CALIBRATION_KIND: StateFileKind<TokenCalibrationState> = {
  noun: "token calibration",
  schemaVersion: 1,
  parse(document, schemaVersion) {
    if (schemaVersion === 1) {
      const models = (document as { models?: unknown } | null)?.models;
      return Array.isArray(models) && models.every(isCalibratedModel)
        ? { ok: true, content: { models } }
        : { ok: false, error: "entries missing model/ratio/overhead" };
    }
    return { ok: false, error: "unknown shape" };
  },
  serialize: (content) => ({ models: content.models }),
};

function calibrationFilePath(): string {
  return `${getJazzHomeDirectory()}/${FILE_NAME}`;
}

/**
 * Load persisted calibration and seed the shared counter.
 *
 * Cannot fail: a missing file means "nothing learned yet", and any other
 * problem (unreadable file, corruption quarantined by the state-file layer)
 * degrades to the in-memory defaults rather than blocking a run.
 */
export function hydrateTokenCalibration(): Effect.Effect<void, never, never> {
  return readStateFile(calibrationFilePath(), TOKEN_CALIBRATION_KIND, {
    onCorrupt: "quarantine",
  }).pipe(
    Effect.flatMap((state) => {
      if (state === undefined) return Effect.void;
      DEFAULT_TOKEN_COUNTER.hydrate(state.models);
      return Effect.void;
    }),
    Effect.ignore,
  );
}

/**
 * Persist the shared counter's learned state, atomically replacing any
 * previous file.
 *
 * Skips the write when nothing has been learned: this runs at the end of
 * every run, and a run that saw no authoritative usage must not overwrite a
 * good file with an empty one.
 */
export function saveTokenCalibration(): Effect.Effect<void, Error, never> {
  const models = DEFAULT_TOKEN_COUNTER.calibratedSnapshot();
  if (models.length === 0) return Effect.void;
  const filePath = calibrationFilePath();
  // writeStateFile does not create parent directories; the Jazz home does not
  // exist for a fresh install until something else writes into it.
  return Effect.sync(() => fs.mkdirSync(path.dirname(filePath), { recursive: true })).pipe(
    Effect.andThen(writeStateFile(filePath, TOKEN_CALIBRATION_KIND, { models })),
  );
}
