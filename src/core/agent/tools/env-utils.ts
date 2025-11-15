export type ProcessEnvRecord = Record<string, string | undefined>;

/**
 * Build a sanitized environment for child process execution.
 * Strips sensitive vars while preserving essentials like PATH.
 */
export function createSanitizedEnv(overrides: ProcessEnvRecord = {}): ProcessEnvRecord {
  const baseEnv: ProcessEnvRecord = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? process.cwd(),
    USER: process.env["USER"] ?? "jazz",
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    ...overrides,
  };

  for (const [key, value] of Object.entries(process.env ?? {})) {
    if (value === undefined) {
      continue;
    }

    if (
      /API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key) ||
      key in baseEnv ||
      key.startsWith("SSH_")
    ) {
      continue;
    }

    baseEnv[key] = value;
  }

  return baseEnv;
}
