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

const cpParameters = z
  .object({
    source: z.string().min(1).describe("Path to copy (file or directory)"),
    destination: z.string().min(1).describe("Destination path"),
    force: z.boolean().optional().describe("Overwrite destination if it exists (default: false)"),
  })
  .strict();

type CpArgs = z.infer<typeof cpParameters>;

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
      if (result.success) {
        return { valid: true, value: result.data };
      }
      return { valid: false, errors: result.error.issues.map((i) => i.message) };
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

        // Guard: destination must not be inside source (prevents endless recursion)
        const normalizedSource = source.endsWith("/") ? source : `${source}/`;
        const normalizedDest = destination.endsWith("/") ? destination : `${destination}/`;
        if (normalizedDest.startsWith(normalizedSource)) {
          return {
            success: false,
            result: null,
            error: `Destination must not be within source: ${destination}`,
          };
        }

        // Destination exists: fail unless force; when force, remove first for true overwrite (not merge)
        const destExists = yield* fs
          .exists(destination)
          .pipe(Effect.catchAll(() => Effect.succeed(false)));

        if (destExists && args.force !== true) {
          return {
            success: false,
            result: null,
            error: `Destination exists: ${destination}. Use force: true to overwrite.`,
          };
        }

        if (destExists && args.force === true) {
          yield* fs.remove(destination, { recursive: true });
        }

        // copy() handles both files and dirs (equivalent to cp -r)
        return yield* fs
          .copy(source, destination, {
            overwrite: args.force === true,
          })
          .pipe(
            Effect.map(() => ({ success: true, result: `Copied: ${source} → ${destination}` })),
            Effect.catchAll((error) =>
              Effect.succeed({
                success: false,
                result: null,
                error: `cp failed: ${error instanceof Error ? error.message : String(error)}`,
              }),
            ),
          );
      }),
  };

  return defineApprovalTool<CpDeps, CpArgs>(config);
}
