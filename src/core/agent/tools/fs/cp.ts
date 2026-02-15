import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Copy files and directories tool.
 * Uses fs.copy (equivalent to cp -r) - handles both files and directories.
 * Uses defineApprovalTool to create approval + execution pair.
 */

type CpArgs = {
  source: string;
  destination: string;
  force?: boolean;
};

const cpParameters = z
  .object({
    source: z.string().min(1).describe("Path to copy (file or directory)"),
    destination: z.string().min(1).describe("Destination path"),
    force: z.boolean().optional().describe("Overwrite destination if it exists (default: false)"),
  })
  .strict();

type CpDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Create cp tools (approval + execution pair).
 */
export function createCpTools(): ApprovalToolPair<CpDeps> {
  const config: ApprovalToolConfig<CpDeps, CpArgs> = {
    name: "cp",
    description:
      "Copy a file or directory. Equivalent to shell cp/cp -r. Directories are copied recursively.",
    tags: ["filesystem", "write"],
    parameters: cpParameters,
    validate: (args) => {
      const result = cpParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as CpArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: CpArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const source = yield* shell.resolvePath(buildKeyFromContext(context), args.source);
        const destination = yield* shell.resolvePath(
          buildKeyFromContext(context),
          args.destination,
          { skipExistenceCheck: true },
        );
        const overwrite = args.force === true ? " (will overwrite if exists)" : "";
        return `About to copy: ${source}\n       to: ${destination}${overwrite}`;
      }),

    handler: (args: CpArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const source = yield* shell.resolvePath(buildKeyFromContext(context), args.source);
        const destination = yield* shell.resolvePath(
          buildKeyFromContext(context),
          args.destination,
          { skipExistenceCheck: true },
        );

        try {
          // If destination exists and force is false, fail
          if (args.force !== true) {
            const destExists = yield* fs
              .exists(destination)
              .pipe(Effect.catchAll(() => Effect.succeed(false)));
            if (destExists) {
              return {
                success: false,
                result: null,
                error: `Destination exists: ${destination}. Use force: true to overwrite.`,
              };
            }
          }

          // copy() handles both files and dirs (equivalent to cp -r)
          yield* fs.copy(source, destination, {
            overwrite: args.force === true,
          });

          return { success: true, result: `Copied: ${source} → ${destination}` };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `cp failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  };

  return defineApprovalTool<CpDeps, CpArgs>(config);
}
