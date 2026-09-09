/**
 * Provenance for memory files: who asserted a fact, when it was written, and
 * when it was last read back.
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
 */

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
}

export interface MemoryScopeProvenance {
  readonly version: 1;
  readonly files: Readonly<Record<string, MemoryFileProvenance>>;
}

export const MEMORY_PROVENANCE_FILENAME = ".provenance.json";

export const EMPTY_MEMORY_SCOPE_PROVENANCE: MemoryScopeProvenance = { version: 1, files: {} };
