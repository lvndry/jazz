/**
 * Service contract for `WorkspaceService` — per-agent, file-backed durable
 * scratch space exposed as a virtual filesystem the agent mutates via tool
 * calls. Deliberately separate from `MemoryService`: memory is small, curated,
 * one-file-per-topic notes; workspace is where large working drafts, research
 * dumps, and intermediate artifacts live, referenced from memory rather than
 * duplicated into it.
 */
import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly sizeBytes: number;
}

export type WorkspaceViewOutcome =
  | {
      readonly kind: "directory";
      readonly path: string;
      readonly entries: readonly WorkspaceDirectoryEntry[];
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
 * Outcome of a mutating workspace action (create/str_replace/insert/delete/rename).
 *
 * Expected failure modes are modeled as `{ success: false, message }` values,
 * not Effect failures — mirroring `MemoryService`. The `Error` channel is
 * reserved for genuinely unexpected conditions: lock-acquisition timeout, disk
 * I/O errors, and guardrail violations (size/count/depth caps, path-safety
 * rejections).
 */
export interface WorkspaceMutationOutcome {
  readonly success: boolean;
  readonly message: string;
}

/**
 * Per-agent, file-backed durable scratch space the agent itself manages via
 * tool calls (view/create/str_replace/insert/delete/rename), scoped by
 * `agentId` so a piece of work survives across sessions on the same agent.
 */
export interface WorkspaceService {
  readonly view: (
    agentId: string,
    virtualPath: string,
    viewRange?: readonly [number, number],
  ) => Effect.Effect<WorkspaceViewOutcome, Error, FileSystem.FileSystem>;

  readonly create: (
    agentId: string,
    virtualPath: string,
    fileText: string,
  ) => Effect.Effect<WorkspaceMutationOutcome, Error, FileSystem.FileSystem>;

  readonly strReplace: (
    agentId: string,
    virtualPath: string,
    oldStr: string,
    newStr: string | undefined,
  ) => Effect.Effect<WorkspaceMutationOutcome, Error, FileSystem.FileSystem>;

  readonly insert: (
    agentId: string,
    virtualPath: string,
    insertLine: number,
    insertText: string,
  ) => Effect.Effect<WorkspaceMutationOutcome, Error, FileSystem.FileSystem>;

  readonly delete: (
    agentId: string,
    virtualPath: string,
  ) => Effect.Effect<WorkspaceMutationOutcome, Error, FileSystem.FileSystem>;

  readonly rename: (
    agentId: string,
    oldVirtualPath: string,
    newVirtualPath: string,
  ) => Effect.Effect<WorkspaceMutationOutcome, Error, FileSystem.FileSystem>;
}

export const WorkspaceServiceTag = Context.GenericTag<WorkspaceService>("WorkspaceService");
