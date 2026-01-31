import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Remove files or directories tool
 * Uses defineApprovalTool to create approval + execution pair.
 */

type RmArgs = {
  path: string;
  recursive?: boolean;
  force?: boolean;
};

const rmParameters = z
  .object({
    path: z.string().min(1).describe("File or directory to remove"),
    recursive: z.boolean().optional().describe("Recursively remove directories"),
    force: z.boolean().optional().describe("Ignore non-existent files and errors"),
  })
  .strict();

type RmDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Create rm tools (approval + execution pair).
 */
export function createRmTools(): ApprovalToolPair<RmDeps> {
  const config: ApprovalToolConfig<RmDeps, RmArgs> = {
    name: "rm",
    description:
      "Remove a file or directory. Use recursive: true for directories. This action may be irreversible.",
    tags: ["filesystem", "destructive"],
    parameters: rmParameters,
    validate: (args) => {
      const result = rmParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as RmArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: RmArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);
        const recurse = args.recursive === true ? " recursively" : "";
        return `About to delete${recurse}: ${target}\n\nThis action may be irreversible.`;
      }),

    handler: (args: RmArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path);

        try {
          // Basic safeguards: do not allow deleting root or home dir directly
          if (target === "/" || target === process.env["HOME"]) {
            return {
              success: false,
              result: null,
              error: `Refusing to remove critical path: ${target}`,
            };
          }

          const st = yield* fs
            .stat(target)
            .pipe(
              Effect.catchAll((err) =>
                args.force ? Effect.fail(err as Error) : Effect.fail(err as Error),
              ),
            );

          if (st.type === "Directory" && args.recursive !== true) {
            return {
              success: false,
              result: null,
              error: `Path is a directory, use recursive: true`,
            };
          }

          yield* fs.remove(target, {
            recursive: args.recursive === true,
            force: args.force === true,
          });

          return { success: true, result: `Removed: ${target}` };
        } catch (error) {
          if (args.force) {
            return {
              success: true,
              result: `Removal attempted with force; error ignored: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return {
            success: false,
            result: null,
            error: `rm failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Types are correct, ESLint can't resolve generics
  return defineApprovalTool<RmDeps, RmArgs>(config);
}
