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
 * Per-agent, file-backed memory the agent itself manages via tool calls
 * (view/create/str_replace/insert/delete/rename), scoped by `agentId` so
 * memory follows an agent across every surface that invokes it.
 */
export interface MemoryService {
  readonly view: (
    agentId: string,
    virtualPath: string,
    viewRange?: readonly [number, number],
  ) => Effect.Effect<MemoryViewOutcome, Error, FileSystem.FileSystem>;

  readonly create: (
    agentId: string,
    virtualPath: string,
    fileText: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly strReplace: (
    agentId: string,
    virtualPath: string,
    oldStr: string,
    newStr: string | undefined,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly insert: (
    agentId: string,
    virtualPath: string,
    insertLine: number,
    insertText: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly delete: (
    agentId: string,
    virtualPath: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;

  readonly rename: (
    agentId: string,
    oldVirtualPath: string,
    newVirtualPath: string,
  ) => Effect.Effect<MemoryMutationOutcome, Error, FileSystem.FileSystem>;
}

export const MemoryServiceTag = Context.GenericTag<MemoryService>("MemoryService");
