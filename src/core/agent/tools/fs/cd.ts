import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Change directory tool
 */

export function createCdTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe("Directory to change to. Absolute or relative to the current working directory."),
    })
    .strict();

  type CdParams = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, CdParams>({
    name: "cd",
    disclosure: "context",
    description:
      "Change this session's working directory. Relative paths in later tool calls (read_file, grep, find, execute_command) resolve from the new directory until you call cd again. Prefer passing path on the tool you are about to use instead of changing directory first.",
    tags: ["filesystem", "navigation"],
    parameters,
    validate: makeZodValidator(parameters),
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
