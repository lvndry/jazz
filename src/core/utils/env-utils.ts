import { resolve } from "node:path";

export type ProcessEnvRecord = Record<string, string | undefined>;

/**
 * Expand a leading `~` to the user's home directory and resolve the result
 * to an absolute path. Safe to call on paths that are already absolute.
 */
export function expandPath(p: string): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const expanded = p.startsWith("~") && home ? p.replace(/^~/, home) : p;
  return resolve(expanded);
}

/**
 * Build a sanitized environment for child process execution.
 * Strips sensitive vars while preserving essentials like PATH.
 */
export function createSanitizedEnv(overrides: ProcessEnvRecord = {}): ProcessEnvRecord {
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
