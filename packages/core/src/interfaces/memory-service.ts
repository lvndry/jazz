/**
 * Service contract for `MemoryService` — file-backed memory exposed as a
 * virtual filesystem the agent mutates via tool calls, partitioned into
 * named scopes (e.g. "personal", "finance", "github-project-a") rather than
 * one silo per agent. Several agents can share a scope; a single agent can
 * hold several scopes.
 */
import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

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

  readonly create: (
    scopes: readonly string[],
    virtualPath: string,
    fileText: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly strReplace: (
    scopes: readonly string[],
    virtualPath: string,
    oldStr: string,
    newStr: string | undefined,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly insert: (
    scopes: readonly string[],
    virtualPath: string,
    insertLine: number,
    insertText: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly delete: (
    scopes: readonly string[],
    virtualPath: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly rename: (
    scopes: readonly string[],
    oldVirtualPath: string,
    newVirtualPath: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;
}

export const MemoryServiceTag = Context.GenericTag<MemoryService>("MemoryService");
