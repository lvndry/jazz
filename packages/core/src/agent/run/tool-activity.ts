/**
 * @fileoverview Per-run record of what its tool calls touched, for directory occupancy.
 *
 * The tool executor resolves every call to a concrete risk level for approval gating. This is
 * a one-line aside at that same decision point: fold the outcome into a small mutable record
 * that the run's heartbeat reads. It carries no policy of its own — "mutating" here means
 * exactly "resolved risk is not `read-only`", the same cut the approval policy makes, so the
 * occupancy report can never disagree with what the run was actually allowed to do.
 *
 * Deliberately dumb: no Effect, no services, one object per run, read by one heartbeat fiber.
 */
import type { ToolRiskLevel } from "@/core/types/tools";

/** One tool call's contribution to the run's activity record. */
export interface ToolActivityInput {
  readonly toolName: string;
  readonly riskLevel: ToolRiskLevel;
  /** The path the call operated on, when it carried one. Shell commands rarely do. */
  readonly path?: string;
  readonly at: string;
}

/** What the heartbeat needs: the last mutating and last read call of the run so far. */
export interface ToolActivitySnapshot {
  readonly lastMutatingAt: string;
  readonly lastMutatingTool: string;
  readonly lastMutatingPath: string;
  readonly lastReadAt: string;
}

export class ToolActivityTracker {
  private lastMutatingAt: string | undefined;
  private lastMutatingTool: string | undefined;
  private lastMutatingPath: string | undefined;
  private lastReadAt: string | undefined;

  /**
   * Record one call after its risk has been resolved. Only the most recent call of each kind
   * matters to the occupancy question, so earlier values are overwritten, not appended.
   */
  record(input: ToolActivityInput): void {
    // `unknown` is counted as mutating, the fail-closed way: the approval gate could not prove
    // the call only reads, and the occupancy report should not be braver than the gate.
    if (input.riskLevel === "read-only") {
      this.lastReadAt = input.at;
      return;
    }
    this.lastMutatingAt = input.at;
    this.lastMutatingTool = input.toolName;
    // A later mutating call without a path does not un-know an earlier one's path: the run
    // did touch that file, and the report is about the tree, not about the last command.
    if (input.path !== undefined) {
      this.lastMutatingPath = input.path;
    }
  }

  snapshot(): ToolActivitySnapshot {
    return {
      lastMutatingAt: this.lastMutatingAt ?? "",
      lastMutatingTool: this.lastMutatingTool ?? "",
      lastMutatingPath: this.lastMutatingPath ?? "",
      lastReadAt: this.lastReadAt ?? "",
    };
  }
}
