import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

export interface FileSystemContextService {
  readonly getCwd: (key: { agentId: string; conversationId?: string }) => Effect.Effect<string>;
  readonly setCwd: (
    key: { agentId: string; conversationId?: string },
    path: string,
  ) => Effect.Effect<void, Error, FileSystem.FileSystem>;
  readonly resolvePath: (
    key: { agentId: string; conversationId?: string },
    path: string,
    options?: { skipExistenceCheck?: boolean },
  ) => Effect.Effect<string, Error, FileSystem.FileSystem>;
  readonly findDirectory: (
    key: { agentId: string; conversationId?: string },
    name: string,
    maxDepth?: number,
  ) => Effect.Effect<
    { results: readonly string[]; warnings?: readonly string[] },
    Error,
    FileSystem.FileSystem
  >;
  readonly resolvePathForMkdir: (
    key: { agentId: string; conversationId?: string },
    path: string,
  ) => Effect.Effect<string, Error, FileSystem.FileSystem>;
  readonly escapePath: (path: string) => string;
}

export const FileSystemContextServiceTag = Context.GenericTag<FileSystemContextService>(
  "FileSystemContextService",
);
