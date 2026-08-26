/**
 * Shared test helpers for fs tool tests.
 */
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";

/**
 * Create a test layer that provides all dependencies needed by fs tools.
 * Uses the real NodeFileSystem and a mock FileSystemContextService
 * pointing at the given `cwd`.
 */
export function createFsTestLayer(cwd: string) {
  const mockFileSystemContextService: FileSystemContextService = {
    getCwd: (_key) => Effect.succeed(cwd),
    setCwd: (_key, _path) => Effect.void,
    resolvePath: (_key, path, _options) =>
      Effect.gen(function* () {
        yield* FileSystem.FileSystem;
        if (path.startsWith("/")) return path;
        if (path.startsWith("~")) {
          const home = process.env["HOME"] || "/tmp";
          return `${home}${path.slice(1)}`;
        }
        return `${cwd}/${path}`;
      }),
    findDirectory: (_key, _name, _maxDepth) => Effect.succeed({ results: [] as readonly string[] }),
    resolvePathForMkdir: (_key, path) =>
      Effect.gen(function* () {
        yield* FileSystem.FileSystem;
        if (path.startsWith("/")) return path;
        return `${cwd}/${path}`;
      }),
    escapePath: (path) => path,
  };

  const shellLayer = Layer.succeed(FileSystemContextServiceTag, mockFileSystemContextService);
  return Layer.mergeAll(Layer.provide(shellLayer, NodeFileSystem.layer), NodeFileSystem.layer);
}

/** Default test context passed to tool.execute(). */
export function testContext(): ToolExecutionContext {
  return {
    agentId: "test-agent",
    conversationId: "test-conversation",
  };
}

/** Run a tool and return the result. */
export function runTool(
  tool: Tool<FileSystem.FileSystem | FileSystemContextService>,
  args: Record<string, unknown>,
  cwd: string,
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    Effect.provide(tool.execute(args, testContext()), createFsTestLayer(cwd)),
  );
}
