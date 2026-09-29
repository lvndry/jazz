/**
 * Remove one user-owned global skill with explicit operator confirmation.
 *
 * `removeSkillCommand` accepts a plain skill name, never a path, and deletes
 * only its directory under `$JAZZ_HOME/skills`. Built-in, project, shared-agent,
 * and plugin skills are outside that scope. Linked roots or skill directories
 * are refused, and the directory identities are checked again after consent.
 * Non-interactive callers must pass `--yes`; removal never contacts a catalog.
 */
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { FileSystemError, ValidationError } from "@jazz/core/types/errors";
import { toError } from "@jazz/core/utils/errors";
import { getGlobalSkillsDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { isValidSkillName } from "./skill-library";

/** Remove the named global skill and its assets after confirmation or `--yes`. */
export function removeSkillCommand(
  name: string,
  options: { readonly yes?: boolean } = {},
): Effect.Effect<void, ValidationError | FileSystemError, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (!isValidSkillName(name)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "name",
          message: `"${name}" is not a valid skill name`,
          value: name,
          suggestion: "Use letters, digits, hyphens, and underscores only; paths are not allowed.",
        }),
      );
    }

    const root = getGlobalSkillsDirectory();
    const directory = join(root, name);
    const inspect = Effect.tryPromise({
      try: async () => {
        const rootStat = await lstat(root);
        const directoryStat = await lstat(directory);
        if (!rootStat.isDirectory() || !directoryStat.isDirectory()) {
          throw new Error("Skill root and target must be real directories, not symbolic links.");
        }
        const skillStat = await lstat(join(directory, "SKILL.md"));
        if (!skillStat.isFile()) throw new Error("The target must contain a regular SKILL.md.");
        return { rootStat, directoryStat };
      },
      catch: (error) =>
        new FileSystemError({
          path: directory,
          operation: "remove",
          reason: toError(error).message,
          suggestion:
            "Choose an existing global skill under ~/.jazz/skills with no symbolic links.",
        }),
    });
    const before = yield* inspect;

    if (options.yes !== true) {
      if (!terminal.isInteractive) {
        yield* terminal.error(
          `Refusing to remove "${name}" without confirmation. Re-run with --yes.`,
        );
        return;
      }
      const confirmed = yield* terminal.confirm(
        `Remove skill "${name}" and all its files at ${directory}? This cannot be undone.`,
        false,
      );
      if (!confirmed) {
        yield* terminal.info("Removal cancelled.");
        return;
      }
    }

    const after = yield* inspect;
    if (
      before.rootStat.dev !== after.rootStat.dev ||
      before.rootStat.ino !== after.rootStat.ino ||
      before.directoryStat.dev !== after.directoryStat.dev ||
      before.directoryStat.ino !== after.directoryStat.ino
    ) {
      return yield* Effect.fail(
        new FileSystemError({
          path: directory,
          operation: "remove",
          reason: "The skill directory changed while removal was awaiting confirmation.",
          suggestion: "Review the current directory and run the removal command again.",
        }),
      );
    }
    yield* Effect.tryPromise({
      try: () => rm(directory, { recursive: true }),
      catch: (error) =>
        new FileSystemError({
          path: directory,
          operation: "remove",
          reason: toError(error).message,
        }),
    });
    yield* terminal.success(`Removed skill "${name}".`);
  });
}
