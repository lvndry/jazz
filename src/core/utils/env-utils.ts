export type ProcessEnvRecord = Record<string, string | undefined>;

/**
 * Build a sanitized environment for child process execution.
 * Strips sensitive vars while preserving essentials like PATH.
 *
 * @param overrides - Values merged into the base environment before scrubbing.
 * @param allowlist - Env var names exempted from the sensitive-name scrub
 * regex. A name only appears in the result if it is present in
 * `process.env` — the allowlist never invents a value. The `SSH_*` prefix
 * block and the `key in baseEnv` guard still apply regardless of allowlist
 * membership.
 */
export function createSanitizedEnv(
  overrides: ProcessEnvRecord = {},
  allowlist: readonly string[] = [],
): ProcessEnvRecord {
  const baseEnv: ProcessEnvRecord = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"],
    USER: process.env["USER"],
    LOGNAME: process.env["LOGNAME"] ?? process.env["USER"] ?? "jazz",
    SHELL: process.env["SHELL"] ?? "/bin/sh",
    LANG: process.env["LANG"] ?? "en_US.UTF-8",
    LC_ALL: process.env["LC_ALL"] ?? "C",
    LC_CTYPE: process.env["LC_CTYPE"] ?? "UTF-8",
    TERM: process.env["TERM"] ?? "xterm-256color",
    PWD: process.cwd(),
    TMPDIR: process.env["TMPDIR"] ?? "/tmp",
    XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"],
    GIT_PAGER: process.env["GIT_PAGER"] ?? "cat",
    GIT_TERMINAL_PROMPT: "0",
    ...overrides,
  };

  for (const [key, value] of Object.entries(process.env ?? {})) {
    if (value === undefined) {
      continue;
    }

    const isAllowlisted = allowlist.includes(key);

    if (
      (!isAllowlisted && /API|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key)) ||
      key in baseEnv ||
      key.startsWith("SSH_")
    ) {
      continue;
    }

    baseEnv[key] = value;
  }

  return baseEnv;
}
