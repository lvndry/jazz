import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Move or rename files and directories tool.
 * Uses fs.rename - equivalent to mv (same filesystem).
 * Uses defineApprovalTool to create approval + execution pair.
 */

const mvParameters = z
  .object({
    source: z.string().min(1).describe("Path to move (file or directory)"),
    destination: z.string().min(1).describe("Destination path (file or directory)"),
    force: z.boolean().optional().describe("Overwrite destination if it exists (default: false)"),
  })
  .strict();

type MvArgs = z.infer<typeof mvParameters>;

type MvDeps = FileSystem.FileSystem | FileSystemContextService;

/**
 * Create mv tools (approval + execution pair).
 */
export function createMvTools(): ApprovalToolPair<MvDeps> {
  const config: ApprovalToolConfig<MvDeps, MvArgs> = {
    name: "mv",
    description: "Move or rename a file or directory. Equivalent to shell mv.",
    tags: ["filesystem", "write"],
    parameters: mvParameters,
    validate: (args) => {
      const result = mvParameters.safeParse(args);
      if (result.success) {
        return { valid: true, value: result.data };
      }
      return { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: MvArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const source = yield* shell.resolvePath(buildKeyFromContext(context), args.source);
        const destination = yield* shell.resolvePath(
          buildKeyFromContext(context),
          args.destination,
          { skipExistenceCheck: true },
        );
        const overwrite = args.force === true ? " (will overwrite if exists)" : "";
        return `About to move: ${source}\n       to: ${destination}${overwrite}`;
      }),

    handler: (args: MvArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const source = yield* shell.resolvePath(buildKeyFromContext(context), args.source);
        const destination = yield* shell.resolvePath(
          buildKeyFromContext(context),
          args.destination,
          { skipExistenceCheck: true },
        );

        // Guard: destination must not be inside source (prevents moving dir into itself)
        const normalizedSource = source.endsWith("/") ? source : `${source}/`;
        const normalizedDest = destination.endsWith("/") ? destination : `${destination}/`;
        if (normalizedDest.startsWith(normalizedSource)) {
          return {
            success: false,
            result: null,
            error: `Destination must not be within source: ${destination}`,
          };
        }

        // Safeguards: refuse moving root or home
        if (source === "/" || source === process.env["HOME"]) {
          return {
            success: false,
            result: null,
            error: `Refusing to move critical path: ${source}`,
          };
        }

        // If destination exists and force is false, fail
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

        // When force is true and destination exists, remove it first — rename() does not overwrite on Unix
        if (destExists && args.force === true) {
          yield* fs.remove(destination, { recursive: true });
        }

        return yield* fs.rename(source, destination).pipe(
          Effect.map(() => ({ success: true, result: `Moved: ${source} → ${destination}` })),
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: `mv failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
          ),
        );
      }),
  };

  return defineApprovalTool<MvDeps, MvArgs>(config);
}
