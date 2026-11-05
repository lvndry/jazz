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
  /** Compact argument preview for the live zone and the settled receipt. */
  argsPreview?: string;
  todoSnapshot?: TodoSnapshotItem[];
  /** True while the command-risk classifier is in flight. */
  classifying?: boolean;
  /** Classifier verdict, once known. */
  classifiedRisk?: string;
}

export interface TodoSnapshotItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  /**
   * What was run to confirm it.
   *
   * Absent on a completed todo means nobody checked — which the interface shows, because
   * "I wrote it" and "I ran it and it passed" are different claims.
   */
  verifiedBy?: string;
}

export type ActivityPhase =
  "idle" | "awaiting" | "thinking" | "streaming" | "tool-execution" | "complete" | "error";

export type ActivityState =
  | { phase: "idle" }
  | {
      /**
       * Request has been sent to the LLM but the first stream event (reasoning,
       * text, or tool) hasn't arrived yet. Visible during prompt eval and any
       * network/queue latency, especially for slow local models. Replaced as
       * soon as a real activity event arrives.
       */
      phase: "awaiting";
      agentName: string;
      provider: string;
      model: string;
      /** Playful gerund-form predicate shown after the agent name (e.g. "is cooking"). */
      label: string;
    }
  | {
      phase: "thinking";
      agentName: string;
    }
  | {
      phase: "streaming";
      agentName: string;
      text: string;
    }
  | {
      phase: "tool-execution";
      agentName: string;
      tools: ActiveTool[];
      todoSnapshot?: TodoSnapshotItem[];
    }
  | { phase: "complete" }
  | {
      phase: "error";
      message: string;
    };

/**
 * Structural equality check for ActivityState to deduplicate React renders.
 */
export function isActivityEqual(left: ActivityState, right: ActivityState): boolean {
  if (left === right) {
    return true;
  }
  if (left.phase !== right.phase) {
    return false;
  }

  switch (left.phase) {
    case "idle":
    case "complete":
      return true;

    case "awaiting":
      return (
        left.agentName === (right as typeof left).agentName &&
        left.provider === (right as typeof left).provider &&
        left.model === (right as typeof left).model &&
        left.label === (right as typeof left).label
      );

    case "thinking":
      return left.agentName === (right as typeof left).agentName;

    case "streaming":
      return (
        left.agentName === (right as typeof left).agentName &&
        left.text === (right as typeof left).text
      );

    case "tool-execution": {
      const bTools = (right as typeof left).tools;
      if (left.agentName !== (right as typeof left).agentName) {
        return false;
      }
      if (left.tools.length !== bTools.length) {
        return false;
      }
      const sameTools = left.tools.every(
        (tool, index) =>
          tool.toolCallId === bTools[index]!.toolCallId &&
          tool.toolName === bTools[index]!.toolName &&
          tool.argsPreview === bTools[index]!.argsPreview &&
          tool.classifying === bTools[index]!.classifying &&
          tool.classifiedRisk === bTools[index]!.classifiedRisk,
      );
      if (!sameTools) {
        return false;
      }

      const aTodos = left.todoSnapshot ?? [];
      const bTodos = (right as typeof left).todoSnapshot ?? [];
      if (aTodos.length !== bTodos.length) {
        return false;
      }
      return aTodos.every(
        (todo, index) =>
          todo.content === bTodos[index]!.content &&
          todo.status === bTodos[index]!.status &&
          // Compared too, or a todo that gained a verification would keep the glyph it had
          // before anyone checked it.
          todo.verifiedBy === bTodos[index]!.verifiedBy,
      );
    }

    case "error":
      return left.message === (right as typeof left).message;
  }
}
