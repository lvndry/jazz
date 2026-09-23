/**
 * Provenance and typing for memory files: what an entry is, who asserted it,
 * when it was written, and when it was last read back. Legacy credit fields
 * remain readable but are not updated from quiet runs or automatic scoring.
 *
 * Kept in a hidden per-scope sidecar rather than in the memory files
 * themselves. Memory files are the artifact a person edits directly — with
 * `$EDITOR` and `git diff` — and they are also exactly what reaches the model,
 * so injecting a header into them would both mean the reviewed artifact is no
 * longer the injected one and shift every line number `str_replace` and
 * `insert` address.
 *
 * There is no trust field. Model-facing writes validate an exact quote against
 * host-authenticated user input at the tool or preflight boundary. Source
 * authentication does not prove a statement is durable or its topic is right.
 *
 * Nothing here is load-bearing for recall. Recall reads the tree, so an entry
 * found or missing on disk behaves the same whether or not this file knows
 * about it, and a sidecar that is lost or corrupt costs history rather than
 * memory. Only what the files cannot express lives here: who wrote an entry
 * and legacy lesson metadata. Outcome credit is dormant pending calibration.
 */

/**
 * The failure a lesson exists to prevent, recorded so the learning loop can
 * check whether that failure recurred and credit or blame the lesson
 * accordingly. An entry without one is recalled like any other but never scored.
 */
export type MemoryFailureSignature =
  | {
      readonly kind: "misfire";
      readonly toolName: string;
      /** Normalized error class, stable across runs so repeats match. */
      readonly errorClass: string;
    }
  | {
      readonly kind: "correction";
      readonly correctedBehavior: string;
    };

/**
 * How an entry has performed when recalled.
 *
 * `failed` and `missed` are deliberately separate. `failed` means the entry was
 * recalled and the failure happened anyway, so its *content* is wrong. `missed`
 * means the failure happened while the entry was not recalled, so its *routing* is
 * wrong. Conflating them would delete a sound entry because retrieval failed to
 * surface it.
 */
export interface MemoryEntryCredit {
  readonly helped: number;
  readonly failed: number;
  readonly missed: number;
  /**
   * Whether this entry's failure has ever been seen. `helped` is only credited once
   * it has: otherwise an entry describing a failure that never happens would
   * accrue credit on every quiet run, which is the cheapest way to game the loop.
   */
  readonly everFired: boolean;
}

export const EMPTY_MEMORY_ENTRY_CREDIT: MemoryEntryCredit = {
  helped: 0,
  failed: 0,
  missed: 0,
  everFired: false,
};

/** Whether an entry was written by the extraction pass or by a person. */
export type MemoryEntryOrigin = "auto" | "user";

export interface MemoryFileProvenance {
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, bumped on every successful write. */
  readonly updatedAt: string;
  /**
   * ISO 8601 of the last `view` that read this file. Recorded but deliberately
   * wired to nothing: personal memory is not re-derivable, so "unused" is a bad
   * proxy for "unimportant" — an allergy is read once a year. The signal is here
   * for a human reviewing memory, not for an automatic deleter.
   */
  readonly lastViewedAt?: string;
  readonly writeCount: number;
  /** Agent ids that have written to this file. */
  readonly writtenBy: readonly string[];

  /**
   * First non-empty line of the entry, derived by the store on every write.
   * Entries are one thought each, so the opening line is the whole point of the
   * entry — it is the text the recall index ranks on, and keeping it derived
   * means it cannot drift from what the file says.
   */
  readonly summary?: string;
  readonly failure?: MemoryFailureSignature;
  readonly credit?: MemoryEntryCredit;
  readonly origin?: MemoryEntryOrigin;
  /** Name of the skill this lesson was distilled into, if any. */
  readonly compiledInto?: string;
  /**
   * Set when a user correction landed on this entry's subject, meaning the
   * entry is no longer right. The next extraction pass receives it together
   * with the correction and must emit one revised entry rather than a second.
   */
  readonly stale?: boolean;
}

/**
 * Entry facts supplied by the caller on a write.
 *
 * Deliberately excludes anything the path or the file already says. Where an
 * entry applies is its directory, what it says is its first line, and both are
 * read from disk — a second copy here would only be a way for the two to
 * disagree.
 */
export interface MemoryEntryMetadata {
  readonly failure?: MemoryFailureSignature;
  readonly origin?: MemoryEntryOrigin;
}

/**
 * Every typing field is optional, so a sidecar written before typing existed
 * reads as a valid record with those fields absent. There is deliberately no
 * schema version: nothing would branch on it, and if a genuinely breaking
 * change ever lands, the absence of a marker is itself detectable and one can
 * be introduced then.
 */
export interface MemoryScopeProvenance {
  readonly files: Readonly<Record<string, MemoryFileProvenance>>;
}

export const MEMORY_PROVENANCE_FILENAME = ".provenance.json";

export const EMPTY_MEMORY_SCOPE_PROVENANCE: MemoryScopeProvenance = { files: {} };
