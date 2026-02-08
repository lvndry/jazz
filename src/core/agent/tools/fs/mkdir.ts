import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Create directory tool
 * Uses defineApprovalTool to create approval + execution pair.
 */

type MkdirArgs = {
  path: string;
  recursive?: boolean;
};

const mkdirParameters = z
  .object({
    path: z.string().min(1).describe("Directory path to create (absolute or relative to cwd)"),
    recursive: z.boolean().optional().describe("Create parent directories as needed (default: true). Set to false to fail if parent directories don't exist."),
  })
  .strict();

type MkdirDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Create mkdir tools (approval + execution pair).
 */
export function createMkdirTools(): ApprovalToolPair<MkdirDeps> {
  const config: ApprovalToolConfig<MkdirDeps, MkdirArgs> = {
    name: "mkdir",
    description:
      "Create a directory (recursive by default — parent directories are created automatically). Safe to call if the directory already exists. Use before write_file when you need to ensure the target directory structure exists.",
    tags: ["filesystem", "write"],
    parameters: mkdirParameters,
    validate: (args) => {
      const result = mkdirParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as MkdirArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: MkdirArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const fs = yield* FileSystem.FileSystem;
        const target = yield* shell.resolvePathForMkdir(buildKeyFromContext(context), args.path);

        const statResult = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (statResult) {
          if (statResult.type === "Directory") {
            return `Directory already exists: ${target}\n\nNo action needed.`;
          } else {
            return `Path exists but is not a directory: ${target}\n\nCannot create directory here.`;
          }
        }

        const options = args.recursive === false ? "" : " (with parents)";
        return `About to create directory: ${target}${options}`;
      }),

    handler: (args: MkdirArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePathForMkdir(buildKeyFromContext(context), args.path);

        const statResult = yield* fs.stat(target).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (statResult) {
          if (statResult.type === "Directory") {
            return { success: true, result: `Directory already exists: ${target}` };
          } else {
            return {
              success: false,
              result: null,
              error: `Cannot create directory '${target}': a file already exists at this path`,
            };
          }
        }

        try {
          yield* fs.makeDirectory(target, { recursive: args.recursive !== false });
          return { success: true, result: `Directory created: ${target}` };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `mkdir failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  };

   
  return defineApprovalTool<MkdirDeps, MkdirArgs>(config);
}
