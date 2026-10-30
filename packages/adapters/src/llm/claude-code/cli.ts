/**
 * Finds the user's own `claude` binary and asks it whether it is signed in. Jazz never reads
 * Claude credentials: requests run through that binary, which holds the sign-in and bills the
 * user's Claude subscription.
 */

export const CLAUDE_CODE_SETUP_REQUIRED_MESSAGE =
  "Claude Code is not set up. Install it, run `claude` once to sign in, then run `jazz config set claude_code`.";

const AUTH_STATUS_TIMEOUT_MS = 10_000;

export type ClaudeCodeSignIn =
  | { readonly status: "signed-in"; readonly authMethod: string | undefined }
  | { readonly status: "signed-out" }
  | { readonly status: "missing" };

/** The `claude` binary to run: the configured path when given, otherwise the first on PATH. */
export function resolveClaudeCodeBinary(configuredPath?: string): string | undefined {
  if (configuredPath !== undefined && configuredPath.length > 0) {
    return Bun.which(configuredPath) ?? undefined;
  }
  return Bun.which("claude") ?? undefined;
}

/** Whether the binary reports a signed-in account, from its own `auth status` command. */
export async function checkClaudeCodeSignIn(binaryPath: string): Promise<ClaudeCodeSignIn> {
  const processHandle = Bun.spawn([binaryPath, "auth", "status"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    timeout: AUTH_STATUS_TIMEOUT_MS,
  });
  const output = await new Response(processHandle.stdout).text();
  await processHandle.exited;
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown; authMethod?: unknown };
    if (parsed.loggedIn !== true) {
      return { status: "signed-out" };
    }
    return {
      status: "signed-in",
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : undefined,
    };
  } catch {
    return { status: "signed-out" };
  }
}
