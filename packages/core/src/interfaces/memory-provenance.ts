/**
 * Provenance and typing for memory files: what an entry is, who asserted it,
 * when it was written, when it was last read back, and how well it has served.
 *
 * Kept in a hidden per-scope sidecar rather than in the memory files
 * themselves. Memory files are the artifact a person edits directly — with
 * `$EDITOR` and `git diff` — and they are also exactly what reaches the model,
 * so injecting a header into them would both mean the reviewed artifact is no
 * longer the injected one and shift every line number `str_replace` and
 * `insert` address.
 *
 * There is no trust field: memory holds facts about a person, so a fact the
 * person never stated has no business being here at all. Rather than record a
 * tier and warn on read, `manage_memory` refuses to write once untrusted
 * external content has entered the run, which is why everything stored is
 * first-hand by construction.
 *
 * What an entry *is* — its kind and workflow — lives in its path, and this
 * sidecar is keyed by that path, so the recall index reads both straight off
 * the key. Only what a path cannot express is stored here: the entry's subject,
 * the failure a lesson guards against, and how well it has served.
 */

/**
 * The failure a lesson exists to prevent, recorded so the learning loop can
 * check whether that failure recurred and credit or blame the lesson
 * accordingly. A lesson without a trigger could never be scored, which is why
 * `manage_memory` requires one.
 */
export type MemoryTrigger =
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
 * recalled and its trigger fired anyway, so its *content* is wrong. `missed`
 * means the trigger fired while the entry was not recalled, so its *routing* is
 * wrong. Conflating them would delete a sound entry because retrieval failed to
 * surface it.
 */
export interface MemoryEntryCredit {
  readonly helped: number;
  readonly failed: number;
  readonly missed: number;
  /**
   * Whether this entry's trigger has ever fired. `helped` is only credited once
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
   * Slug of what this entry is *about*. Facts and preferences are
   * single-entry-per-subject, so this is what makes a repeat write resolve to
   * the existing entry instead of adding a near-duplicate beside it.
   */
  readonly subject?: string;
  /**
   * First non-empty line of the entry, derived by the store on every write.
   * Entries are one thought each, so the opening line is the whole point of the
   * entry — it is the text the recall index ranks on, and keeping it derived
   * means it cannot drift from what the file says.
   */
  readonly summary?: string;
  readonly trigger?: MemoryTrigger;
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
 * Deliberately excludes kind and workflow: both are encoded in the entry's
 * path, and the sidecar is keyed by that path, so anything reading the index
 * can parse them for free. Storing a second copy would only create a way for
 * the two to disagree after a rename. `summary` is likewise absent — the store
 * derives it from the file so it cannot drift from what the file says.
 */
export interface MemoryEntryMetadata {
  readonly subject: string;
  readonly trigger?: MemoryTrigger;
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
