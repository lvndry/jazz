import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";
import { normalizeStatSize } from "./utils";

/**
 * Get file/directory status and metadata tool
 */

export function createStatTool(): Tool<FileSystem.FileSystem | FileSystemContextService> {
  const parameters = z
    .object({
      path: z
        .string()
        .min(1)
        .describe(
          "File or directory to inspect. Absolute or relative to the session working directory.",
        ),
    })
    .strict();

  type StatArgs = z.infer<typeof parameters>;

  return defineTool<FileSystem.FileSystem | FileSystemContextService, StatArgs>({
    name: "stat",
    disclosure: "context",
    description:
      "Check whether a path exists and return its type, size in bytes, and modification times. A missing path is a successful result with exists set to false — not an error. Prefer this over ls -la or test -f via execute_command.",
    tags: ["filesystem", "info"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });

        try {
          const stat = yield* fs.stat(target);
          const normalizedSize = normalizeStatSize((stat as { size: unknown }).size);
          return {
            success: true,
            result: {
              path: target,
              exists: true,
              type: stat.type,
              size: normalizedSize,
              mtime: stat.mtime,
              atime: stat.atime,
            },
          };
        } catch (error) {
          // Check if it's a "not found" error
          if (error instanceof Error) {
            const cause = (error as { cause?: { code?: string } }).cause;
            const code = typeof cause?.code === "string" ? cause.code : undefined;
            if (code?.includes("ENOENT")) {
              return {
                success: true,
                result: {
                  path: target,
                  exists: false,
                  type: null,
                  size: null,
                  mtime: null,
                  atime: null,
                },
              };
            }
          }

          return {
            success: false,
            result: null,
            error: `stat failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
  });
}
