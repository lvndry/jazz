/**
 * Which calls of a tool batch must wait for an earlier call because both change the same path.
 *
 * Calls of a batch run at once. Two filesystem mutations of one path (a `write_file` and an
 * `edit_file`, a `write_file` and an `rm`) would interleave in an unspecified order, so each
 * call waits for the earlier calls of its batch whose paths overlap its own, which makes the
 * outcome the one the model's call order describes. Calls on unrelated paths, and every call
 * that is not one of the tools below, still run together. A shell command's paths are not
 * knowable from its arguments, so `execute_command` is not ordered here.
 */

import * as path from "node:path";

/** The argument names holding a path a filesystem tool changes or reads while changing. */
const PATH_ARGUMENTS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  write_file: ["path"],
  edit_file: ["path"],
  rm: ["path"],
  mkdir: ["path"],
  mv: ["source", "destination"],
  cp: ["source", "destination"],
};

/** The paths, as the model wrote them, that a call to `toolName` with `args` mutates. */
export function mutatedPathArguments(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): string[] {
  const names = PATH_ARGUMENTS_BY_TOOL[toolName] ?? [];
  return names.flatMap((name) => {
    const value = args[name];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
}

/** Whether two absolute paths are the same or one contains the other. */
function pathsOverlap(first: string, second: string): boolean {
  const relation = path.relative(first, second);
  const reverse = path.relative(second, first);
  const inside = (relative: string) =>
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return inside(relation) || inside(reverse);
}

/**
 * For each call, the indexes of the earlier calls it must wait for: those with a path that
 * overlaps one of its own. `pathsByCall[index]` holds the absolute paths call `index` mutates.
 */
export function earlierCallsOnSamePaths(pathsByCall: ReadonlyArray<readonly string[]>): number[][] {
  return pathsByCall.map((paths, index) => {
    if (paths.length === 0) {
      return [];
    }
    const earlier: number[] = [];
    for (let candidate = 0; candidate < index; candidate++) {
      const candidatePaths = pathsByCall[candidate] ?? [];
      if (candidatePaths.some((other) => paths.some((own) => pathsOverlap(own, other)))) {
        earlier.push(candidate);
      }
    }
    return earlier;
  });
}
