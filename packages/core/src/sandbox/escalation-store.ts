/**
 * @fileoverview Keeping a run's open escalation offers in its run record, so an approval given
 * after the process that made the offer is gone still finds it.
 *
 * `storeGrant` records an offer when the shell tool makes it; `clearGrant` removes it when the
 * escalated retry runs, so a second resume cannot spend it again. Both are best effort and
 * no-ops without a run store in the layer or without a record for the run, since only a run that
 * can park has a record that outlives the process.
 */

import { Effect } from "effect";
import { RunStoreTag } from "@/core/interfaces/run-store";
import { addGrant, removeGrant, type EscalationGrant } from "./escalation";

export function storeGrant(runId: string, grant: EscalationGrant): Effect.Effect<void> {
  return Effect.gen(function* () {
    const store = yield* Effect.serviceOption(RunStoreTag);
    if (store._tag === "None" || runId.length === 0) {
      return;
    }
    const record = yield* store.value.get(runId);
    if (record === undefined) {
      return;
    }
    yield* store.value.save({ ...record, escalations: addGrant(record.escalations, grant) });
  });
}

export function clearGrant(runId: string, command: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const store = yield* Effect.serviceOption(RunStoreTag);
    if (store._tag === "None" || runId.length === 0) {
      return;
    }
    const record = yield* store.value.get(runId);
    if (record === undefined || record.escalations === undefined) {
      return;
    }
    yield* store.value.save({ ...record, escalations: removeGrant(record.escalations, command) });
  });
}
