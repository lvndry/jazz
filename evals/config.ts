/**
 * Evaluation runner defaults and the model cost guardrail.
 * `isAllowedEvalModel` gates agent configurations before an eval starts so a
 * benchmark cannot silently switch from a local or cheap model to a costly API.
 */
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

/**
 * Cost guardrail: eval runs may ONLY use free or cheap models — any OpenRouter
 * ":free" model, a user-run llama.cpp or vLLM server, any Ollama model (local
 * inference, or a `-cloud` tag metered by the user's Ollama plan rather than
 * per token), or the two cheap OpenAI tiers
 * (gpt-5.4-nano / gpt-5.4-mini). Anything else (e.g. full gpt-5.4) is rejected
 * so a run can't quietly rack up cost. Enforced at runtime (runner and the
 * memory runners) and in a repo test over committed agents.
 */
export const ALLOWED_OPENAI_EVAL_MODELS = ["gpt-5.4-nano", "gpt-5.4-mini"] as const;

export function isAllowedEvalModel(provider: string, model: string): boolean {
  if (provider === "openrouter" && model.endsWith(":free")) {
    return true;
  }
  if (provider === "ollama" || provider === "llamacpp" || provider === "vllm") {
    return true;
  }
  if (provider === "openai" && (ALLOWED_OPENAI_EVAL_MODELS as readonly string[]).includes(model)) {
    return true;
  }
  return false;
}
