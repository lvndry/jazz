import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "@/core/interfaces/fs";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Print working directory tool
 */

export function createPwdTool(): Tool<FileSystemContextService> {
  const parameters = z.object({}).strict();
  return defineTool<FileSystemContextService, Record<string, never>>({
    name: "pwd",
    disclosure: "context",
    description:
      "Print this session's working directory. The same directory is used by filesystem tools and execute_command. cd changes it. This is not a new shell process.",
    tags: ["filesystem", "navigation"],
    parameters,
    validate: makeZodValidator(parameters),
    handler: (_args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const cwd = yield* shell.getCwd(buildKeyFromContext(context));
        return { success: true, result: cwd };
      }),
  });
}
