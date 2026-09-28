import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { toError } from "@/core/utils/errors";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
import { replacePathAtomically } from "./atomic-replace";
import { buildKeyFromContext } from "../context-utils";
import { jazzStateApproval } from "./jazz-state-approval";

/**
 * Move or rename files and directories tool.
 * A rename where it can be one; replacing a destination or crossing filesystems stages the
 * result and swaps it in, so an interrupted move leaves a complete destination or no change.
 * Uses defineApprovalTool to create approval + execution pair.
 */

const mvParameters = z
  .object({
    source: z.string().min(1).describe("File or directory to move."),
    destination: z.string().min(1).describe("Final path, including the name."),
    force: z.boolean().optional().describe("Delete an existing destination first."),
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
    disclosure: "public",
    description: "Rename or move a file or directory within one filesystem.",
    tags: ["filesystem", "write"],
    parameters: mvParameters,
    validate: makeZodValidator(mvParameters),

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
        return jazzStateApproval(
          `About to move: ${source}\n       to: ${destination}${overwrite}`,
          [source, destination],
        );
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

        return yield* moveAtomically(fs, source, destination, destExists).pipe(
          Effect.map(() => ({ success: true, result: `Moved: ${source} → ${destination}` })),
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: `mv failed: ${toError(error).message}`,
            }),
          ),
        );
      }),
  };

  return defineApprovalTool<MvDeps, MvArgs>(config);
}

/** `rename` failing because source and destination are on different filesystems. */
function isCrossDeviceError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return (error as { code?: unknown } | undefined)?.code === "EXDEV" || cause?.code === "EXDEV";
}

/**
 * Move `source` to `destination` so that it ends complete or unchanged. A plain rename onto a
 * free destination is already atomic. Replacing an existing destination, or crossing
 * filesystems (a copy, then removing the source), goes through {@link replacePathAtomically},
 * with the source removed in the same uninterruptible step as the swap.
 */
function moveAtomically(
  fs: FileSystem.FileSystem,
  source: string,
  destination: string,
  destinationExists: boolean,
): Effect.Effect<void, Error> {
  const direct = destinationExists
    ? Effect.fail(new Error("destination exists"))
    : fs.rename(source, destination).pipe(Effect.mapError(toError));
  return direct.pipe(
    Effect.catchAll((error) => {
      if (!destinationExists && !isCrossDeviceError(error)) {
        return Effect.fail(error);
      }
      let copied = false;
      return replacePathAtomically(
        fs,
        destination,
        (stagingPath) =>
          fs.rename(source, stagingPath).pipe(
            Effect.catchAll((renameError) => {
              if (!isCrossDeviceError(renameError)) {
                return Effect.fail(toError(renameError));
              }
              copied = true;
              return fs.copy(source, stagingPath).pipe(Effect.mapError(toError));
            }),
          ),
        Effect.suspend(() =>
          copied
            ? fs.remove(source, { recursive: true }).pipe(Effect.mapError(toError))
            : Effect.void,
        ),
      );
    }),
  );
}
