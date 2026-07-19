import { machineSpecGroundingCheck } from "../../checks";
import type { EvalTask } from "../../types";

const PROBE_PATTERNS = [
  /system_profiler/i,
  /sysctl\b/i,
  /systeminfo/i,
  /wmic\s+(cpu|memorychip|computersystem)/i,
  /lscpu/i,
  /\bfree\s+-h?\b/i,
];

const ASK_BACK_PATTERNS = [
  /what(?:'s| is) your (ram|memory|chip|cpu|gpu|processor)/i,
  /(please|could you) (tell|share|provide|specify) (me )?(your|the) (ram|memory|specs|hardware)/i,
  /how much (ram|memory) (do|does) (you|your (machine|laptop|computer|server)) have/i,
];

function machineSpecTask(id: string, subject: string): EvalTask {
  return {
    id,
    domain: "grounding",
    prompt: `What are the best Ollama models I can run on ${subject}?`,
    baseDifficulty: "medium",
    setup() {},
    check(result) {
      return machineSpecGroundingCheck(result, {
        probePatterns: PROBE_PATTERNS,
        askBackPatterns: ASK_BACK_PATTERNS,
      });
    },
  };
}

export const tasks: EvalTask[] = [
  machineSpecTask("grounding-ollama-macbook", "this MacBook"),
  machineSpecTask("grounding-ollama-laptop", "this laptop"),
  machineSpecTask("grounding-ollama-server", "this server"),
];
