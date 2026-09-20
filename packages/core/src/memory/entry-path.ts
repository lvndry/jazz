/**
 * Typed memory entry paths.
 *
 * An entry's kind and workflow are encoded in its path rather than in the file
 * body, because memory files are the artifact a person edits directly and are
 * also exactly what reaches the model: a frontmatter header would both change
 * the reviewed artifact and shift every line number `str_replace` and `insert`
 * address. The hidden per-scope sidecar mirrors what is parsed here so the
 * index can filter without walking the tree, but the path stays authoritative.
 *
 * Layout:
 *   <scope>/facts/<slug>.md
 *   <scope>/preferences/<workflow|_global>/<slug>.md
 *   <scope>/lessons/<workflow|_global>/<slug>.md
 *   <scope>/skills/<name>/SKILL.md        (reserved; written via manage_skill)
 *
 * Paths that do not start with a known kind segment are legacy entries written
 * before typing existed. They parse as `undefined` and callers treat them as
 * facts, so an existing store keeps working untouched.
 */
import { MAX_MEMORY_PATH_SEGMENT_LENGTH } from "../constants/memory";

export const MEMORY_ENTRY_KINDS = ["fact", "preference", "lesson"] as const;

export type MemoryEntryKind = (typeof MEMORY_ENTRY_KINDS)[number];

/** Directory segment each kind lives under, directly below the scope. */
export const MEMORY_KIND_SEGMENTS: Readonly<Record<MemoryEntryKind, string>> = {
  fact: "facts",
  preference: "preferences",
  lesson: "lessons",
};

/**
 * Reserved segment for agent-authored skills. Skills are directories rather
 * than single files and are written through `manage_skill`, so they are not a
 * `MemoryEntryKind`, but the segment is reserved here so a skill path is never
 * mistaken for a legacy untyped entry.
 */
export const MEMORY_SKILLS_SEGMENT = "skills";

/**
 * Workflow segment for entries that apply to every task rather than one kind
 * of work. A global preference is always injected; a workflow-scoped one is
 * injected when that workflow is active.
 */
export const GLOBAL_WORKFLOW_SEGMENT = "_global";

/** Kinds that carry a workflow segment. Facts are not workflow-scoped. */
const WORKFLOW_SCOPED_KINDS: readonly MemoryEntryKind[] = ["preference", "lesson"];

export interface ParsedMemoryEntryPath {
  readonly scope: string;
  readonly kind: MemoryEntryKind;
  /** `undefined` means the entry applies globally (stored under `_global`). */
  readonly workflow: string | undefined;
  readonly slug: string;
}

const SEGMENT_TO_KIND: ReadonlyMap<string, MemoryEntryKind> = new Map(
  MEMORY_ENTRY_KINDS.map((kind) => [MEMORY_KIND_SEGMENTS[kind], kind]),
);

export function isMemoryEntryKind(value: unknown): value is MemoryEntryKind {
  return typeof value === "string" && (MEMORY_ENTRY_KINDS as readonly string[]).includes(value);
}

export function isWorkflowScopedKind(kind: MemoryEntryKind): boolean {
  return WORKFLOW_SCOPED_KINDS.includes(kind);
}

function splitSegments(virtualPath: string): string[] {
  return virtualPath.split("/").filter((segment) => segment.length > 0);
}

/**
 * Normalizes free text into a path-safe kebab-case segment.
 *
 * Used for both subjects and workflow tags so that a subject and the slug it
 * produces agree, which is what lets a repeat write be recognised as targeting
 * an existing entry rather than a new one.
 */
export function slugifyMemorySegment(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_MEMORY_PATH_SEGMENT_LENGTH);
}

/** A parsed entry path with the scope segment stripped. */
export type ParsedMemoryEntryRelativePath = Omit<ParsedMemoryEntryPath, "scope">;

/**
 * Parses the portion of an entry path below its scope root — the form the
 * store itself works in, since a scope's files are addressed relative to that
 * scope's directory.
 */
export function parseMemoryEntryRelativePath(
  relativePath: string,
): ParsedMemoryEntryRelativePath | undefined {
  const segments = splitSegments(relativePath);
  if (segments.length < 2) return undefined;

  const [kindSegment, ...rest] = segments;
  if (kindSegment === undefined) return undefined;

  const kind = SEGMENT_TO_KIND.get(kindSegment);
  if (kind === undefined) return undefined;

  if (!isWorkflowScopedKind(kind)) {
    if (rest.length !== 1) return undefined;
    const slug = rest[0];
    if (slug === undefined) return undefined;
    return { kind, workflow: undefined, slug };
  }

  if (rest.length !== 2) return undefined;
  const [workflowSegment, slug] = rest;
  if (workflowSegment === undefined || slug === undefined) return undefined;

  return {
    kind,
    workflow: workflowSegment === GLOBAL_WORKFLOW_SEGMENT ? undefined : workflowSegment,
    slug,
  };
}

/**
 * Parses a typed entry path, or returns `undefined` for a legacy untyped path
 * or a reserved skills path.
 */
export function parseMemoryEntryPath(virtualPath: string): ParsedMemoryEntryPath | undefined {
  const segments = splitSegments(virtualPath);
  const scope = segments[0];
  if (scope === undefined) return undefined;

  const parsed = parseMemoryEntryRelativePath(segments.slice(1).join("/"));
  if (parsed === undefined) return undefined;

  return { scope, ...parsed };
}

export interface BuildMemoryEntryPathInput {
  readonly scope: string;
  readonly kind: MemoryEntryKind;
  readonly subject: string;
  /** Omitted or `undefined` stores a workflow-scoped kind under `_global`. */
  readonly workflow?: string;
}

/** Builds the canonical path an entry must live at, given its kind and subject. */
export function buildMemoryEntryPath(input: BuildMemoryEntryPathInput): string {
  const slug = `${slugifyMemorySegment(input.subject)}.md`;
  const kindSegment = MEMORY_KIND_SEGMENTS[input.kind];

  if (!isWorkflowScopedKind(input.kind)) {
    return `${input.scope}/${kindSegment}/${slug}`;
  }

  const workflowSegment =
    input.workflow === undefined || input.workflow.length === 0
      ? GLOBAL_WORKFLOW_SEGMENT
      : slugifyMemorySegment(input.workflow);

  return `${input.scope}/${kindSegment}/${workflowSegment}/${slug}`;
}

/**
 * Explains why a declared kind disagrees with the path it was written to, or
 * returns `undefined` when they agree.
 *
 * A mismatch is rejected rather than silently corrected: a preference filed
 * under `facts/` would never be injected by the always-on core, so accepting it
 * would lose the write in a way neither the agent nor the user could see.
 */
export function describeMemoryPathKindMismatch(
  virtualPath: string,
  declaredKind: MemoryEntryKind,
): string | undefined {
  const parsed = parseMemoryEntryPath(virtualPath);
  if (parsed === undefined) {
    const expectedSegment = MEMORY_KIND_SEGMENTS[declaredKind];
    const shape = isWorkflowScopedKind(declaredKind)
      ? `<scope>/${expectedSegment}/<workflow|${GLOBAL_WORKFLOW_SEGMENT}>/<slug>.md`
      : `<scope>/${expectedSegment}/<slug>.md`;
    return `Path "${virtualPath}" is not a valid ${declaredKind} path. Expected ${shape}.`;
  }

  if (parsed.kind !== declaredKind) {
    return `Path "${virtualPath}" stores a ${parsed.kind}, but kind "${declaredKind}" was declared. Move the entry or correct the kind.`;
  }

  return undefined;
}
