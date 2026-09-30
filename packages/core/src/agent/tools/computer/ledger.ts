/**
 * A record of what computer use did: which app, which action, which element, when, and how it
 * turned out.
 *
 * It never holds a screenshot or typed text, and an element's label is redacted and shortened,
 * so the ledger is safe to read back and to keep. Append-only and size-bounded, like the peer
 * ledger; past the cap the file rotates, so it describes recent use.
 */

import * as path from "node:path";
import { redactSecretText, type KnownSecret } from "@/core/secrets/redaction";
import { appendBoundedJsonlLine, readJsonlNewestFirst } from "@/core/utils/bounded-jsonl";
import { isRecord } from "@/core/utils/is-record";
import { computerDirectory } from "./grants";

/** Size at which the ledger rotates; an entry is about 300 bytes, so roughly 7,000 actions. */
export const LEDGER_MAX_BYTES = 2 * 1024 * 1024;

/** Longest element label kept in an entry, in characters. */
const MAX_LEDGER_LABEL_CHARS = 60;

/** Most bytes one read scans, so asking for the latest few entries never loads the whole file. */
const LEDGER_READ_BYTES = LEDGER_MAX_BYTES;

export type LedgerOutcome = "ok" | "refused" | "failed" | "stopped";

export interface LedgerEntry {
  readonly timestamp: string;
  readonly agentId: string;
  readonly conversationId?: string;
  readonly bundleId: string;
  readonly app: string;
  readonly action: string;
  readonly target?: string;
  readonly delivery?: string;
  readonly outcome: LedgerOutcome;
  readonly detail?: string;
}

export function ledgerPath(): string {
  return path.join(computerDirectory(), "ledger.jsonl");
}

/** A label as the ledger keeps it: secrets redacted, whitespace collapsed, length capped. */
export function ledgerLabel(label: string, known: readonly KnownSecret[]): string {
  const tidy = redactSecretText(label, known).replace(/\s+/g, " ").trim();
  return tidy.length > MAX_LEDGER_LABEL_CHARS
    ? `${tidy.slice(0, MAX_LEDGER_LABEL_CHARS - 1)}…`
    : tidy;
}

export async function appendLedgerEntry(entry: LedgerEntry): Promise<void> {
  await appendBoundedJsonlLine(ledgerPath(), JSON.stringify(entry), { maxBytes: LEDGER_MAX_BYTES });
}

function parseLedgerLine(line: string): LedgerEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      !isRecord(parsed) ||
      typeof parsed["timestamp"] !== "string" ||
      typeof parsed["bundleId"] !== "string" ||
      typeof parsed["action"] !== "string" ||
      typeof parsed["outcome"] !== "string"
    ) {
      return undefined;
    }
    return parsed as unknown as LedgerEntry;
  } catch {
    return undefined;
  }
}

/** The latest entries, newest first. */
export function readLedger(limit: number): Promise<LedgerEntry[]> {
  return readJsonlNewestFirst(ledgerPath(), {
    parse: parseLedgerLine,
    limit,
    maxBytes: LEDGER_READ_BYTES,
  });
}
