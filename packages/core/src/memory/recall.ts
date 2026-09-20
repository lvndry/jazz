/**
 * Choosing which memory entries a turn should see.
 *
 * Recall is deterministic: an active workflow is decided by matching the
 * request text against the workflow tags the store already holds, and ranking
 * is lexical. There are no embeddings, and no model call is made to decide what
 * to recall — a recall step that itself needed a model would cost a round trip
 * on every turn and could fail in ways the turn cannot recover from.
 *
 * Two groups come out, split by whether the request can change them. Standing
 * preferences apply to every task, so they are stable enough to freeze into the
 * cached prompt and the model never has to look them up. Contextual entries are
 * chosen for this turn and belong in the message stream. Both are carried as
 * summaries with a path, keeping bodies out of context until they are wanted.
 */
import {
  type MemoryEntryKind,
  parseMemoryEntryRelativePath,
  slugifyMemorySegment,
} from "./entry-path";
import type { MemoryFileProvenance } from "../interfaces/memory-provenance";
import { matchesWholeWord } from "../utils/string";

export interface MemoryIndexEntry {
  /** Scope-qualified path, as the memory tools address it. */
  readonly path: string;
  readonly kind: MemoryEntryKind;
  /** `undefined` means the entry applies to every workflow. */
  readonly workflow: string | undefined;
  readonly subject: string | undefined;
  readonly summary: string;
}

/**
 * Builds the recall index for one scope from its sidecar.
 *
 * Kind and workflow are read off each record's key rather than stored, so the
 * index cannot disagree with where the entry actually lives. Untyped entries
 * written before typing existed are skipped: they have no kind to route on, and
 * they stay reachable through `view_memory`.
 */
export function buildMemoryIndex(
  scope: string,
  files: Readonly<Record<string, MemoryFileProvenance>>,
): readonly MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = [];

  for (const [relativePath, record] of Object.entries(files)) {
    const parsed = parseMemoryEntryRelativePath(relativePath);
    if (parsed === undefined) continue;

    entries.push({
      path: `${scope}/${relativePath}`,
      kind: parsed.kind,
      workflow: parsed.workflow,
      subject: record.subject,
      summary: record.summary ?? parsed.slug.replace(/\.md$/, "").replace(/-/g, " "),
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/** Every distinct workflow tag present in the index. */
export function collectWorkflows(entries: readonly MemoryIndexEntry[]): readonly string[] {
  const workflows = new Set<string>();
  for (const entry of entries) {
    if (entry.workflow !== undefined) workflows.add(entry.workflow);
  }
  return [...workflows].sort();
}

/**
 * Decides which workflows the request is about.
 *
 * Matching is against the request text alone, never the working directory: a
 * preference is about a kind of work, so it has to be recalled wherever that
 * work happens rather than only where it was first learned.
 *
 * A hyphenated tag is also matched as one word, so `mood-board` fires on
 * "moodboard" — the tag was coined by an earlier turn and its exact spelling is
 * not something the user should have to reproduce.
 */
export function classifyActiveWorkflows(
  requestText: string,
  entries: readonly MemoryIndexEntry[],
): readonly string[] {
  const text = requestText.toLowerCase();
  if (text.trim().length === 0) return [];

  const collapsedText = text.replace(/[^a-z0-9]+/g, "");

  return collectWorkflows(entries).filter((workflow) => {
    if (matchesWholeWord(text, workflow)) return true;
    const collapsedWorkflow = slugifyMemorySegment(workflow).replace(/-/g, "");
    return collapsedWorkflow.length > 2 && collapsedText.includes(collapsedWorkflow);
  });
}

function isActiveFor(entry: MemoryIndexEntry, activeWorkflows: readonly string[]): boolean {
  return entry.workflow === undefined || activeWorkflows.includes(entry.workflow);
}

/**
 * Scores an entry against the request by how much of its own wording appears
 * there.
 *
 * The direction matters: the request is long and the entry is short, so the
 * entry's distinctive words are looked for in the request, not the other way
 * round. Short words are skipped because they match everything.
 */
function scoreAgainstRequest(entry: MemoryIndexEntry, requestText: string): number {
  const terms = new Set(
    `${entry.subject ?? ""} ${entry.summary}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3),
  );
  if (terms.size === 0) return 0;

  let matched = 0;
  for (const term of terms) {
    if (matchesWholeWord(requestText, term)) matched += 1;
  }
  return matched;
}

export interface RecallSelection {
  /**
   * Preferences that apply to every task. Request-independent, so these can be
   * frozen into the cached system prompt without a per-turn rewrite.
   */
  readonly standing: readonly MemoryIndexEntry[];
  /**
   * Entries selected because of what this turn is about — preferences whose
   * workflow is active, plus anything ranked against the request.
   *
   * These change from turn to turn, so they belong in the message stream. Put
   * in the system prompt they would rewrite its tail on every turn and discard
   * the prefix cache for the whole conversation.
   */
  readonly contextual: readonly MemoryIndexEntry[];
  readonly activeWorkflows: readonly string[];
}

export interface SelectRecallInput {
  readonly entries: readonly MemoryIndexEntry[];
  readonly requestText: string;
  /** Cap on standing preferences, so an always-on set cannot grow unbounded. */
  readonly maxStanding?: number;
  readonly maxRanked?: number;
}

export const DEFAULT_MAX_STANDING_ENTRIES = 24;
export const DEFAULT_MAX_RANKED_ENTRIES = 5;

export function selectRecall(input: SelectRecallInput): RecallSelection {
  const maxStanding = input.maxStanding ?? DEFAULT_MAX_STANDING_ENTRIES;
  const maxRanked = input.maxRanked ?? DEFAULT_MAX_RANKED_ENTRIES;
  const requestText = input.requestText.toLowerCase();
  const activeWorkflows = classifyActiveWorkflows(input.requestText, input.entries);

  const standing = input.entries
    .filter((entry) => entry.kind === "preference" && entry.workflow === undefined)
    .slice(0, maxStanding);

  const activePreferences = input.entries.filter(
    (entry) =>
      entry.kind === "preference" &&
      entry.workflow !== undefined &&
      activeWorkflows.includes(entry.workflow),
  );

  const alreadySelected = new Set([...standing, ...activePreferences].map((entry) => entry.path));

  const ranked = input.entries
    .filter((entry) => !alreadySelected.has(entry.path) && isActiveFor(entry, activeWorkflows))
    .map((entry) => ({ entry, score: scoreAgainstRequest(entry, requestText) }))
    .filter((scored) => scored.score > 0)
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.entry.path.localeCompare(right.entry.path),
    )
    .slice(0, maxRanked)
    .map((scored) => scored.entry);

  return { standing, contextual: [...activePreferences, ...ranked], activeWorkflows };
}
