/**
 * Enables the Claude Code provider after confirming the user's own `claude` binary is installed
 * and signed in. Nothing secret is stored: the config entry only records that it is enabled.
 * Resolves to whether the provider is now enabled.
 */

import { checkClaudeCodeSignIn, resolveClaudeCodeBinary } from "@jazz/adapters/llm/claude-code";
import { CLAUDE_CODE_SETUP_HINT } from "@jazz/core/constants/provider-env-vars";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";

export function enableClaudeCode(
  terminal: TerminalService,
  configService: AgentConfigService,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const binaryPath = resolveClaudeCodeBinary();
    if (binaryPath === undefined) {
      yield* terminal.warn(`Claude Code was not found on PATH. ${CLAUDE_CODE_SETUP_HINT}`);
      return false;
    }
    const signIn = yield* Effect.promise(() => checkClaudeCodeSignIn(binaryPath));
    if (signIn.status !== "signed-in") {
      yield* terminal.warn(`Claude Code is installed but not signed in. ${CLAUDE_CODE_SETUP_HINT}`);
      return false;
    }
    yield* configService.set("llm.claude_code", { enabled: true });
    yield* terminal.success(
      "Claude Code enabled. Requests run through your own `claude` and use your Claude subscription.",
    );
    return true;
  });
}
