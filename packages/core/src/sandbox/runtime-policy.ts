/**
 * @fileoverview The write policy a running tool call is held to, and the guard the in-process
 * file tools call before they mutate a path.
 *
 * `writePolicyFor` builds the policy from the session's working directory plus this process's
 * home, temp directory and Jazz scratch directory, so the shell tool and the file tools confine
 * to one set of roots. When the working directory is inside a git repository the policy adds the
 * repository's top level and git directories (`findRepositoryRoots`), so `git` works from a subdirectory. The working directory is the session's own, never a path the model
 * passed in: confining to a model-chosen `workingDirectory` would let it confine itself to `/`.
 *
 * `denyWriteOutsideRoots` is the file tools' one-line hook: call it with the paths a mutation
 * will touch and return its result when it is defined.
 *
 *     const denied = yield* denyWriteOutsideRoots(context, [source, destination]);
 *     if (denied !== undefined) {
 *       return denied;
 *     }
 *
 * It is undefined when confinement is off for the run or every path is inside a root, and a
 * failed tool result naming the path otherwise.
 */

import os from "node:os";
import { Effect } from "effect";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { ToolExecutionContext } from "@/core/types/tools";
import { getWorkspaceDirectory } from "@/core/utils/paths";
import { buildKeyFromContext } from "../agent/tools/context-utils";
import { findRepositoryRoots } from "./repository-roots";
import { buildWritePolicy, firstUnwritablePath, type WritePolicy } from "./write-policy";

export function writePolicyFor(sessionCwd: string): WritePolicy {
  return buildWritePolicy({
    workspace: sessionCwd,
    homeDir: os.homedir(),
    jazzScratchDirectory: getWorkspaceDirectory(),
    platform: process.platform,
    tempDirectory: os.tmpdir(),
    extraRoots: findRepositoryRoots(sessionCwd, os.homedir()),
  });
}

/** What the model is told when a file tool refuses a path outside the writable roots. */
export function fsWriteDeniedMessage(deniedPath: string, sessionCwd: string): string {
  return (
    `Write confinement is on: ${deniedPath} is outside the writable roots, which are the working ` +
    `directory (${sessionCwd}), temp directories and developer tool caches. ` +
    `Write inside ${sessionCwd}, or tell the person this path needs writing so they can run it themselves.`
  );
}

export function denyWriteOutsideRoots(context: ToolExecutionContext, targets: readonly string[]) {
  return Effect.gen(function* () {
    if (context.shellConfinement !== "on") {
      return undefined;
    }
    const sessionCwd = yield* (yield* FileSystemContextServiceTag).getCwd(
      buildKeyFromContext(context),
    );
    const deniedPath = firstUnwritablePath(writePolicyFor(sessionCwd), targets, sessionCwd);
    if (deniedPath === undefined) {
      return undefined;
    }
    const logger = yield* Effect.serviceOption(LoggerServiceTag);
    if (logger._tag === "Some") {
      yield* logger.value.info("File write refused by write confinement", {
        deniedPath,
        sessionCwd,
        toolCallId: context.toolCallId,
      });
    }
    return {
      success: false as const,
      result: null,
      error: fsWriteDeniedMessage(deniedPath, sessionCwd),
    };
  });
}
