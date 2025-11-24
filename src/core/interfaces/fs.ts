import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

export interface FileSystemContextService {
  /** Gets the current working directory for the given agent/conversation context. */
  readonly getCwd: (key: { agentId: string; conversationId?: string }) => Effect.Effect<string>;
  /** Sets the current working directory for the given agent/conversation context. */
  readonly setCwd: (
    key: { agentId: string; conversationId?: string },
    path: string,
  ) => Effect.Effect<void, Error, FileSystem.FileSystem>;
  /** Resolves a path relative to the current working directory, optionally skipping existence check. */
  readonly resolvePath: (
    key: { agentId: string; conversationId?: string },
    path: string,
    options?: { skipExistenceCheck?: boolean },
  ) => Effect.Effect<string, Error, FileSystem.FileSystem>;
  /** Finds directories by name within the current working directory, up to maxDepth levels. */
  readonly findDirectory: (
    key: { agentId: string; conversationId?: string },
    name: string,
    maxDepth?: number,
  ) => Effect.Effect<
    { results: readonly string[]; warnings?: readonly string[] },
    Error,
    FileSystem.FileSystem
  >;
  /** Resolves a path for mkdir operations, ensuring parent directories exist. */
  readonly resolvePathForMkdir: (
    key: { agentId: string; conversationId?: string },
    path: string,
  ) => Effect.Effect<string, Error, FileSystem.FileSystem>;
  /** Escapes special characters in a path string for safe use in shell commands. */
  readonly escapePath: (path: string) => string;
}

export const FileSystemContextServiceTag = Context.GenericTag<FileSystemContextService>(
  "FileSystemContextService",
);
