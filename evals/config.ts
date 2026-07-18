export interface EvalConfig {
  sutAgentId: string;
  ceilingAgentId: string;
  judgeAgentId: string;
  samplesPerTask: number;
  concurrency: number;
  timeoutMs: number;
  judgeCalibrationMinPearson: number;
}

export const EVAL_CONFIG: EvalConfig = {
  sutAgentId: "eval-sut", // OpenRouter free model; see evals/agents/eval-sut.json
  ceilingAgentId: "eval-ceiling",
  judgeAgentId: "eval-judge",
  samplesPerTask: 5,
  concurrency: 4,
  timeoutMs: 300_000,
  judgeCalibrationMinPearson: 0.7,
};
