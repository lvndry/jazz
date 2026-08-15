let currentCommandName: string | undefined;

/**
 * Record which CLI command is executing, as a space-separated path
 * (`agent list`, `workflow run`).
 *
 * Only the command path is stored — never positional arguments or option
 * values, which routinely carry prompts, file paths, and other user content
 * that must not end up in telemetry.
 */
export function setCurrentCommandName(name: string): void {
  currentCommandName = name;
}

export function getCurrentCommandName(): string | undefined {
  return currentCommandName;
}
