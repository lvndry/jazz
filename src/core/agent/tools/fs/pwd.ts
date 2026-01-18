import { Effect } from "effect";
import { z } from "zod";
import { type FileSystemContextService, FileSystemContextServiceTag } from "../../../interfaces/fs";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { buildKeyFromContext } from "../context-utils";

/**
 * Print working directory tool
 */

export function createPwdTool(): Tool<FileSystemContextService> {
  const parameters = z.object({}).strict();
  return defineTool<FileSystemContextService, Record<string, never>>({
    name: "pwd",
    description: "Print the current working directory for this agent session",
    tags: ["filesystem", "navigation"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as unknown as Record<string, never> }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const cwd = yield* shell.getCwd(buildKeyFromContext(context));
        return { success: true, result: cwd };
      }),
  });
}
