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
    disclosure: "internal",
    description: "Print the session working directory tools resolve relative paths against.",
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
