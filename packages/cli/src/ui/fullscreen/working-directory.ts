/** A directory as a person reads it: the home prefix becomes `~`. */
export function compactWorkingDirectory(
  workingDirectory: string | null,
  home: string | undefined = process.env["HOME"],
): string {
  const cwd = workingDirectory ?? process.cwd();
  if (home !== undefined && home.length > 0 && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}
