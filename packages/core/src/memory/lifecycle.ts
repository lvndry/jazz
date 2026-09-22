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

function creditFor(provenance: MemoryFileProvenance): MemoryEntryCredit {
  return provenance.credit ?? { helped: 0, failed: 0, missed: 0, everFired: false };
}

/** Apply one observed run outcome without mutating the original provenance record. */
export function applyMemoryOutcome(
  provenance: MemoryFileProvenance,
  input: MemoryOutcomeInput,
): MemoryFileProvenance {
  const previous = creditFor(provenance);
  const nextCredit: MemoryEntryCredit = {
    helped: previous.helped + (input.recalled && !input.triggerFired && previous.everFired ? 1 : 0),
    failed: previous.failed + (input.recalled && input.triggerFired ? 1 : 0),
    missed: previous.missed + (!input.recalled && input.triggerFired ? 1 : 0),
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
