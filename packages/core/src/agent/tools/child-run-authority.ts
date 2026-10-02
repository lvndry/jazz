/**
 * What a child run (a sub-agent, a media companion) inherits from the run that spawns it.
 *
 * Spawning grants nothing new: the child runs under the parent's live approval policy
 * getter (so a mode switch reaches it, and no policy stays no policy), the same command and
 * tool allowlists by reference, the parent's egress taint (so untrusted content the parent
 * read still gates the child's egress), the parent's typed secrets (so the child redacts them
 * and can pass their placeholders to the tools that take them), and at most the parent's effective tool set. When the
 * parent's set is unknown the child gets no tools, unless the parent is itself an explicit
 * `unrestrictedTools` caller, in which case the child resolves the agent's own toolset.
 *
 * Spread the result into `AgentRunner.runRecursive` options; a caller that needs a narrower
 * toolset (a companion takes none) overrides `toolAllowlist` after the spread.
 */
import type { AgentRunnerOptions } from "@/core/agent/types";
import type { ToolExecutionContext } from "@/core/types/tools";

export type ChildRunAuthority = Pick<
  AgentRunnerOptions,
  | "toolAllowlist"
  | "autoApprovePolicy"
  | "autoApprovedCommands"
  | "autoApprovedTools"
  | "egressTaint"
  | "userSecrets"
  | "browserSessions"
>;

export function childRunAuthority(context: ToolExecutionContext): ChildRunAuthority {
  const toolAllowlist =
    context.effectiveToolNames !== undefined
      ? [...context.effectiveToolNames]
      : context.unrestrictedTools === true
        ? undefined
        : [];
  return {
    ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
    ...(context.getAutoApprovePolicy !== undefined
      ? { autoApprovePolicy: context.getAutoApprovePolicy }
      : {}),
    ...(context.autoApprovedCommands !== undefined
      ? { autoApprovedCommands: context.autoApprovedCommands }
      : {}),
    ...(context.autoApprovedTools !== undefined
      ? { autoApprovedTools: context.autoApprovedTools }
      : {}),
    ...(context.egressTaint !== undefined ? { egressTaint: context.egressTaint } : {}),
    ...(context.userSecrets !== undefined ? { userSecrets: context.userSecrets } : {}),
    ...(context.browserSessions !== undefined ? { browserSessions: context.browserSessions } : {}),
  };
}
