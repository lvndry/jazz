/** Approved whole-file transfers keep bytes out of tool results and preserve secret protection. */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { ToolExecutionContext } from "@/core/types";
import { toError } from "@/core/utils/errors";
import { assertNotProtectionStateMutation } from "@/core/utils/protected-files";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
import { replacePathAtomically } from "./atomic-replace";
import { describeFootprint, measureFootprint } from "./footprint";
import { protectFileTransfer } from "./protected-transfer";
import { buildKeyFromContext } from "../context-utils";

/**
 * Copy files and directories tool.
 * Uses fs.copy (equivalent to cp -r) - handles both files and directories.
 * Uses defineApprovalTool to create approval + execution pair.
 */

const cpParameters = z
  .object({
    source: z.string().min(1).describe("File or directory; copied recursively."),
    destination: z.string().min(1).describe("Final path, including the name."),
    force: z.boolean().optional().describe("Delete an existing destination first."),
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
    disclosure: "public",
    description:
      "Copy whole files or directories without reading contents into context. Use this for .env and secret files; approval shows paths only and copies remain protected.",
    tags: ["filesystem", "write"],
    parameters: cpParameters,
    validate: makeZodValidator(cpParameters),

    approvalMessage: (args: CpArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const source = yield* shell.resolvePath(buildKeyFromContext(context), args.source);
        const destination = yield* shell.resolvePath(
          buildKeyFromContext(context),
          args.destination,
          { skipExistenceCheck: true },
        );
        yield* Effect.try({
          try: () => assertNotProtectionStateMutation(destination),
          catch: toError,
        });
        const overwrite = args.force === true ? " (will overwrite if exists)" : "";
        const message = `About to copy: ${source}\n       to: ${destination}${overwrite}`;
        const footprint = yield* measureFootprint(source);
        return footprint === undefined
          ? message
          : { message, impact: describeFootprint(footprint) };
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

        // Destination exists: fail unless force; with force it is replaced whole, never merged
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

        const protectedTransfer = yield* Effect.tryPromise({
          try: () => protectFileTransfer(source, destination),
          catch: toError,
        });
        const copySource = protectedTransfer
          ? yield* fs.realPath(source).pipe(Effect.mapError(toError))
          : source;

        // Copied beside the destination and swapped in whole, so an interrupted copy leaves
        // the destination as it was: a true overwrite, never a merge or a half-copied tree.
        return yield* replacePathAtomically(fs, destination, (stagingPath) =>
          fs.copy(copySource, stagingPath).pipe(
            Effect.mapError(toError),
            Effect.tap(() =>
              protectedTransfer
                ? fs.stat(stagingPath).pipe(
                    Effect.flatMap((info) =>
                      fs.chmod(stagingPath, info.type === "Directory" ? 0o700 : 0o600),
                    ),
                    Effect.mapError(toError),
                  )
                : Effect.void,
            ),
          ),
        ).pipe(
          Effect.map(() => ({ success: true, result: `Copied: ${source} → ${destination}` })),
          Effect.catchAll((error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: `cp failed: ${toError(error).message}`,
            }),
          ),
        );
      }),
  };

  return defineApprovalTool<CpDeps, CpArgs>(config);
}
