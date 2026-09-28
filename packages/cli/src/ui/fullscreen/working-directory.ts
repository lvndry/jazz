import { abbreviateHomePath } from "@jazz/core/utils/storage";

/** A directory as a person reads it: the home prefix becomes `~`. */
export function compactWorkingDirectory(
  workingDirectory: string | null,
  home: string | undefined = process.env["HOME"],
): string {
  return abbreviateHomePath(workingDirectory ?? process.cwd(), home);
}
