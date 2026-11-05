/**
 * @fileoverview The one-retry escalation budget for a command a confined run could not finish.
 *
 * When a confined command fails on a write denial, the tool result offers the model a single
 * retry with an `escalate` justification. That offer is an `EscalationLedger` entry keyed on the
 * run and the exact command: `offer` records it, `peek` lets the approval step check the retry
 * answers a real denial, and `consume` spends it when the unconfined command actually runs, so a
 * denied command can be escalated once and never again, and a command that was never denied
 * cannot be escalated at all. The ledger is bounded: the oldest offers are dropped past
 * `MAX_OPEN_OFFERS`, which closes the offer rather than widening it.
 */

/** Open offers kept across all runs in a process; an offer is spent or abandoned within a few turns. */
export const MAX_OPEN_OFFERS = 256;

export interface EscalationLedger {
  offer(runId: string, command: string, deniedPath: string): void;
  /** The path a command was denied on, when an offer for it is open. */
  peek(runId: string, command: string): string | undefined;
  /** Spends the offer; true only the first time, and only when one was open. */
  consume(runId: string, command: string): boolean;
}

function offerKey(runId: string, command: string): string {
  return `${runId}\u0000${command.trim()}`;
}

export function createEscalationLedger(maxOpenOffers: number = MAX_OPEN_OFFERS): EscalationLedger {
  const offers = new Map<string, string>();
  return {
    offer(runId, command, deniedPath) {
      const key = offerKey(runId, command);
      offers.delete(key);
      offers.set(key, deniedPath);
      while (offers.size > maxOpenOffers) {
        const oldest = offers.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        offers.delete(oldest);
      }
    },
    peek(runId, command) {
      return offers.get(offerKey(runId, command));
    },
    consume(runId, command) {
      return offers.delete(offerKey(runId, command));
    },
  };
}

/** The process-wide ledger `execute_command` uses. */
export const shellEscalationLedger: EscalationLedger = createEscalationLedger();
