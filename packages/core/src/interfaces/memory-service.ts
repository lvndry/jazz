/**
 * Service contract for `MemoryService` — file-backed memory exposed as a
 * virtual filesystem the agent mutates via tool calls, partitioned into
 * named scopes (e.g. "personal", "finance", "github-project-a") rather than
 * one silo per agent. Several agents can share a scope; a single agent can
 * hold several scopes.
 */
import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";
import type { MemoryEntryMetadata, MemoryFileProvenance } from "./memory-provenance";

/** An entry the current turn should act on. */
export interface MemoryEntryInForce {
  /** Scope-qualified path, as the memory tools address it. */
  readonly path: string;
  /** `undefined` means the entry is in force on every task. */
  readonly topic: string | undefined;
  /** First non-empty line: entries are one thought each, so this is the point. */
  readonly summary: string;
}

export interface MemoryDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly sizeBytes: number;
}

export type MemoryViewOutcome =
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly entries: readonly MemoryDirectoryEntry[];
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly content: string;
      readonly startLine: number;
      readonly totalLines: number;
      readonly truncated: boolean;
    }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "too_large"; readonly message: string };

/**
 * Outcome of a mutating memory action (create/str_replace/insert/delete/rename).
 *
 * Expected failure modes — no match, multiple matches, out-of-range insert,
 * path already exists — are modeled as `{ success: false, message }` VALUES,
 * not Effect failures, mirroring how Anthropic's own memory tool reports
 * these as `is_error`-flagged tool results rather than exceptions. The
 * `Error` channel on `MemoryService` methods is reserved for genuinely
 * unexpected conditions: lock-acquisition timeout, disk I/O errors, and
 * guardrail violations (size/count/depth caps, path-safety rejections).
 */
export interface MemoryMutationOutcome {
  readonly success: boolean;
  readonly message: string;
}

/**
 * Who is writing. Required on every mutating call so a shared scope can report
 * which agents have touched a file.
 *
 * Whether a write is *allowed* is decided before this, in `manage_memory`: a
 * run that has ingested untrusted external content cannot write memory at all.
 */
export interface MemoryWriteContext {
  readonly agentId: string;
  /**
   * Typing recorded alongside the write. Supplied when an entry is created so
   * the sidecar mirrors what the path encodes; omitted on later edits, which
   * carry the existing typing forward untouched.
   */
  readonly entry?: MemoryEntryMetadata;
}

/**
 * File-backed memory an agent manages via tool calls (view/create/str_replace/
 * insert/delete/rename), partitioned into named scopes rather than one silo
 * per agent.
 *
 * Every method takes `scopes`: the caller's full set of accessible scope
 * names (from `AgentConfig.memoryScopes`, or `[agentId]` for a caller with no
 * configured scopes). `virtualPath`'s first path segment selects which of
 * those scopes the call targets (e.g. `"personal/preferences.md"`); an empty
 * or root `virtualPath` on `view` lists the accessible scopes themselves
 * rather than any one scope's files. A `virtualPath` naming a scope outside
 * `scopes` is treated as not found — scopes are a strict allowlist, not a
 * namespace the caller can address freely.
 */
export interface MemoryService {
  readonly view: (
    scopes: readonly string[],
    virtualPath: string,
    viewRange?: readonly [number, number],
  ) => Effect.Effect<MemoryViewOutcome, Error, FileSystem.FileSystem>;

  /**
   * Standing entries: everything under `always/` in the accessible scopes.
   *
   * Topic-scoped entries are the agent's responsibility to discover via
   * `view_memory` — the recall path cannot do semantic association, so it
   * only injects what applies unconditionally.
   */
  readonly standingEntries: (
    scopes: readonly string[],
  ) => Effect.Effect<readonly MemoryEntryInForce[], Error, FileSystem.FileSystem>;

  readonly create: (
    scopes: readonly string[],
    virtualPath: string,
    fileText: string,
    writeContext: MemoryWriteContext,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly strReplace: (
    scopes: readonly string[],
    virtualPath: string,
    oldStr: string,
    newStr: string | undefined,
    writeContext: MemoryWriteContext,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly insert: (
    scopes: readonly string[],
    virtualPath: string,
    insertLine: number,
    insertText: string,
    writeContext: MemoryWriteContext,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly delete: (
    scopes: readonly string[],
    virtualPath: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  /**
   * Provenance for one file, or undefined when nothing is recorded for it —
   * a file written before provenance tracking, or edited outside Jazz.
   */
  readonly provenance: (
    scopes: readonly string[],
    virtualPath: string,
  ) => Effect.Effect<MemoryFileProvenance | undefined, Error, FileSystem.FileSystem>;

  readonly rename: (
    scopes: readonly string[],
    oldVirtualPath: string,
    newVirtualPath: string,
    writeContext: MemoryWriteContext,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;
}

export const MemoryServiceTag = Context.GenericTag<MemoryService>("MemoryService");
