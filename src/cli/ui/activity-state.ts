/**
 * Activity state machine types for the unified activity island.
 *
 * Replaces the separate StatusIsland + StreamIsland with a single
 * discriminated union that drives one ActivityView component.
 */

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
  startedAt: number;
}

export type ActivityPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool-execution"
  | "complete"
  | "error";

export type ActivityState =
  | { phase: "idle" }
  | {
      phase: "thinking";
      agentName: string;
      reasoning: string;
    }
  | {
      phase: "streaming";
      agentName: string;
      reasoning: string;
      text: string;
    }
  | {
      phase: "tool-execution";
      agentName: string;
      tools: ActiveTool[];
    }
  | { phase: "complete" }
  | {
      phase: "error";
      message: string;
    };

/**
 * Structural equality check for ActivityState to deduplicate React renders.
 */
export function isActivityEqual(a: ActivityState, b: ActivityState): boolean {
  if (a === b) return true;
  if (a.phase !== b.phase) return false;

  switch (a.phase) {
    case "idle":
    case "complete":
      return true;

    case "thinking":
      return a.agentName === (b as typeof a).agentName && a.reasoning === (b as typeof a).reasoning;

    case "streaming":
      return (
        a.agentName === (b as typeof a).agentName &&
        a.reasoning === (b as typeof a).reasoning &&
        a.text === (b as typeof a).text
      );

    case "tool-execution": {
      const bTools = (b as typeof a).tools;
      if (a.agentName !== (b as typeof a).agentName) return false;
      if (a.tools.length !== bTools.length) return false;
      return a.tools.every(
        (t, i) => t.toolCallId === bTools[i]!.toolCallId && t.toolName === bTools[i]!.toolName,
      );
    }

    case "error":
      return a.message === (b as typeof a).message;
  }
}
