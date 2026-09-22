/** Pure memory lifecycle transitions used to credit recalled lessons and record evidence. */

import { MAX_MEMORY_EVIDENCE } from "@/core/constants/memory";
import type {
  MemoryEntryCredit,
  MemoryEvidence,
  MemoryFileProvenance,
} from "@/core/interfaces/memory-provenance";

export interface MemoryOutcomeInput {
  readonly recalled: boolean;
  readonly triggerFired: boolean;
  readonly runId: string;
  readonly evidence?: MemoryEvidence;
}

export type MemoryOutcomeKind = "helped" | "failed" | "missed" | "noop";

/**
 * Names what one run says about an entry. `helped` needs the entry's failure
 * to have fired at least once before: an entry describing a failure that never
 * happens would otherwise be credited on every quiet run.
 */
export function classifyMemoryOutcome(
  input: { readonly recalled: boolean; readonly triggerFired: boolean },
  everFired: boolean,
): MemoryOutcomeKind {
  if (input.recalled && input.triggerFired) return "failed";
  if (!input.recalled && input.triggerFired) return "missed";
  if (input.recalled && everFired) return "helped";
  return "noop";
}

function creditFor(provenance: MemoryFileProvenance): MemoryEntryCredit {
  return provenance.credit ?? { helped: 0, failed: 0, missed: 0, everFired: false };
}

/** Apply one observed run outcome without mutating the original provenance record. */
export function applyMemoryOutcome(
  provenance: MemoryFileProvenance,
  input: MemoryOutcomeInput,
): MemoryFileProvenance {
  const previous = creditFor(provenance);
  const outcome = classifyMemoryOutcome(input, previous.everFired);
  const nextCredit: MemoryEntryCredit = {
    helped: previous.helped + (outcome === "helped" ? 1 : 0),
    failed: previous.failed + (outcome === "failed" ? 1 : 0),
    missed: previous.missed + (outcome === "missed" ? 1 : 0),
    everFired: previous.everFired || input.triggerFired,
  };
  const evidence =
    input.evidence === undefined
      ? provenance.evidence
      : [...(provenance.evidence ?? []), input.evidence].slice(-MAX_MEMORY_EVIDENCE);
  return {
    ...provenance,
    credit: nextCredit,
    ...(evidence === undefined ? {} : { evidence }),
  };
}
