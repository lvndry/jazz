import { plausibleFreeDiskGB, toolGroundedAnswerCheck } from "../../checks";
import type { CheckResult, EvalTask, OneShotResult } from "../../types";

const DISK_CHECK_TOOL_PATTERNS = [
  /\bdf\s+-h?\b/i,
  /diskutil\s+(info|list)/i,
  /get-psdrive/i,
  /wmic\s+logicaldisk/i,
];

function freeSpaceGB(answer: string): number | undefined {
  const match = answer.match(/([0-9][0-9,.]*)\s*(gb|tb|gib|tib)\b/i);
  if (!match) return undefined;
  const value = parseFloat(match[1]!.replace(/,/g, ""));
  const unit = match[2]!.toLowerCase();
  return unit.startsWith("t") ? value * 1024 : value;
}

export const tasks: EvalTask[] = [
  {
    id: "grounding-disk-space",
    domain: "grounding",
    prompt: "How much free disk space do I have on this machine?",
    baseDifficulty: "medium",
    setup() {},
    check(result: OneShotResult, workspaceDir: string): CheckResult {
      const grounded = toolGroundedAnswerCheck(result, {
        toolNames: ["execute_command"],
        toolArgPatterns: DISK_CHECK_TOOL_PATTERNS,
        answerPatterns: [/\d+(\.\d+)?\s*(gb|tb|gib|tib)\b/i],
      });
      if (!grounded.pass) return grounded;

      const stated = freeSpaceGB(result.answer);
      const { min, max } = plausibleFreeDiskGB(workspaceDir);
      const plausible = stated !== undefined && stated >= min && stated <= max;
      return {
        pass: plausible,
        score: plausible ? 1 : 0.5,
        detail: plausible
          ? `checked real disk state, ${stated}GB is plausible (~${Math.round(min)}-${Math.round(max)}GB expected)`
          : `checked disk state via a real command, but stated ${stated ?? "no"}GB is implausible (expected ~${Math.round(min)}-${Math.round(max)}GB)`,
      };
    },
  },
];
