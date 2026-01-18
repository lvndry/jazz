import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../../interfaces/fs";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Change directory tool
 */

export function createCdTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z.string().min(1).describe("Path to change directory to"),
    })
    .strict();

  type CdParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, CdParams>({
    name: "cd",
    description: "Change the current working directory for this agent session",
    tags: ["filesystem", "navigation"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? {
            valid: true,
            value: params.data,
          }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;

        const target = yield* shell
          .resolvePath(buildKeyFromContext(context), args.path)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (target === null) {
          return {
            success: false,
            result: null,
            error: `Path not found: ${args.path}`,
          };
        }

        try {
          const stat = yield* fs.stat(target);
          if (stat.type !== "Directory") {
            return { success: false, result: null, error: `Not a directory: ${target}` };
          }
          yield* shell.setCwd(buildKeyFromContext(context), target);
          return { success: true, result: target };
        } catch (error) {
          return {
            success: false,
            result: null,
            error: `cd failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
