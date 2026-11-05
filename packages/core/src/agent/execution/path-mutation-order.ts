/**
 * Which calls of a tool batch must wait for an earlier call because both change the same path.
 *
 * Calls of a batch run at once. Two mutations of one path (a `write_file` and an `edit_file`,
 * a `write_file` and an `rm`) would interleave in an unspecified order, so each call waits for
 * the earlier calls of its batch whose paths overlap its own, which makes the outcome the one
 * the model's call order describes. Calls on unrelated paths, and every call that is not one of
 * the tools below, still run together. A shell command's paths are not knowable from its
 * arguments, so `execute_command` is not ordered here.
 */

import * as path from "node:path";
import { Effect, type FileSystem } from "effect";
import { buildKeyFromContext } from "@/core/agent/tools/context-utils";
import { createPdfOutputPaths } from "@/core/agent/tools/create-pdf";
import type { FileSystemContextService } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types/tools";

/**
 * Where a tool's path arguments point. `filesystem` paths resolve against the agent's working
 * directory; `scratchpad` paths against the agent's own scratchpad root.
 */
interface MutatingTool {
  readonly pathArguments: readonly string[];
  readonly space: "filesystem" | "scratchpad";
}

const FILESYSTEM_MUTATORS: Readonly<Record<string, MutatingTool>> = {
  write_file: { pathArguments: ["path"], space: "filesystem" },
  edit_file: { pathArguments: ["path"], space: "filesystem" },
  rm: { pathArguments: ["path"], space: "filesystem" },
  mkdir: { pathArguments: ["path"], space: "filesystem" },
  mv: { pathArguments: ["source", "destination"], space: "filesystem" },
  cp: { pathArguments: ["source", "destination"], space: "filesystem" },
  manage_scratchpad: { pathArguments: ["path", "old_path", "new_path"], space: "scratchpad" },
};

/** Stands in for the agent's scratchpad root, so scratchpad paths never overlap real ones. */
function scratchpadRoot(agentId: string): string {
  return path.join(path.sep, `jazz-scratchpad:${agentId}`);
}

function stringArguments(
  args: Readonly<Record<string, unknown>>,
  names: readonly string[],
): string[] {
  return names.flatMap((name) => {
    const value = args[name];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
}

/**
 * The absolute paths a call to `toolName` with `args` changes, resolved the way the tool
 * resolves them. Empty for a tool that changes no path the model names.
 */
export function resolveMutatedPaths(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  context: ToolExecutionContext,
  fileSystemContext: FileSystemContextService | undefined,
): Effect.Effect<string[], never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const mutator = FILESYSTEM_MUTATORS[toolName];
    if (mutator === undefined && toolName !== "create_pdf") {
      return [];
    }
    const workingDirectory = yield* fileSystemContext === undefined
      ? Effect.succeed(process.cwd())
      : Effect.try(() => fileSystemContext.getCwd(buildKeyFromContext(context))).pipe(
          Effect.flatten,
          Effect.map((cwd) => (typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd())),
          Effect.catch(() => Effect.succeed(process.cwd())),
        );

    if (toolName === "create_pdf") {
      const title = typeof args["title"] === "string" ? args["title"] : "";
      const requestedPath = typeof args["path"] === "string" ? args["path"] : undefined;
      return createPdfOutputPaths(
        { title, ...(requestedPath !== undefined ? { path: requestedPath } : {}) },
        workingDirectory,
      );
    }

    if (mutator === undefined) {
      return [];
    }
    const rawPaths = stringArguments(args, mutator.pathArguments);
    if (mutator.space === "scratchpad") {
      const root = scratchpadRoot(context.agentId);
      return rawPaths.map((rawPath) => path.resolve(root, rawPath));
    }
    return yield* Effect.all(
      rawPaths.map((rawPath) =>
        fileSystemContext === undefined
          ? Effect.succeed(path.resolve(workingDirectory, rawPath))
          : fileSystemContext
              .resolvePath(buildKeyFromContext(context), rawPath, { skipExistenceCheck: true })
              .pipe(
                Effect.map((resolved) => path.resolve(workingDirectory, resolved)),
                Effect.catch(() => Effect.succeed(path.resolve(workingDirectory, rawPath))),
              ),
      ),
    );
  });
}

/** One directory level of the path trie: the latest call still ordering this exact path. */
interface PathNode {
  latestCall: number | undefined;
  readonly children: Map<string, PathNode>;
}

function newPathNode(): PathNode {
  return { latestCall: undefined, children: new Map() };
}

function pathComponents(absolutePath: string): string[] {
  return absolutePath.split(path.sep).filter((component) => component.length > 0);
}

/** Every call still ordering a path at or below `node`, forgetting them as they are covered. */
function takeSubtreeCalls(node: PathNode, into: Set<number>): void {
  if (node.latestCall !== undefined) {
    into.add(node.latestCall);
    node.latestCall = undefined;
  }
  for (const child of node.children.values()) {
    takeSubtreeCalls(child, into);
  }
  node.children.clear();
}

/**
 * For each call, the earlier calls it must wait for so that it follows every earlier call on an
 * overlapping path (the same path, an ancestor or a descendant), in call order.
 * `pathsByCall[index]` holds the absolute paths call `index` mutates.
 *
 * A call waits only for the calls not already ordered before one it waits for: the latest call on
 * each path it touches, and the latest uncovered call below it. A batch of n calls on one path
 * therefore holds n - 1 dependencies, and building them costs time linear in the path lengths.
 */
export function earlierCallsOnSamePaths(pathsByCall: ReadonlyArray<readonly string[]>): number[][] {
  const root = newPathNode();
  return pathsByCall.map((paths, index) => {
    const waitsFor = new Set<number>();
    const landings: PathNode[] = [];
    for (const absolutePath of paths) {
      let node = root;
      for (const component of pathComponents(absolutePath)) {
        if (node.latestCall !== undefined) {
          waitsFor.add(node.latestCall);
        }
        let child = node.children.get(component);
        if (child === undefined) {
          child = newPathNode();
          node.children.set(component, child);
        }
        node = child;
      }
      takeSubtreeCalls(node, waitsFor);
      landings.push(node);
    }
    for (const landing of landings) {
      landing.latestCall = index;
    }
    waitsFor.delete(index);
    return [...waitsFor].sort((first, second) => first - second);
  });
}
