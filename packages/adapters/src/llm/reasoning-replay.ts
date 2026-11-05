/**
 * How a provider's wire format treats reasoning that Jazz stored from earlier assistant
 * messages.
 *
 * - `none`: the provider cannot accept reasoning back (Ollama and llama.cpp emit it but ignore
 *   it on input), so nothing is replayed.
 * - `current-turn`: reasoning is replayed on assistant messages after the last user message,
 *   which is the tool loop of the in-flight turn.
 * - `all-turns`: reasoning is replayed on every assistant message that has it.
 *
 * `textRequired` marks wire formats that carry only the reasoning text. Parts without text
 * (payload-only parts such as encrypted content) are meaningless there and are skipped.
 */
export interface ReasoningReplayPolicy {
  readonly scope: "none" | "current-turn" | "all-turns";
  readonly textRequired: boolean;
}

const NO_REPLAY: ReasoningReplayPolicy = { scope: "none", textRequired: false };

/**
 * Anthropic requires its signed thinking blocks. OpenAI and ChatGPT continue from the previous
 * reasoning item: by reference when the item is stored, or from its encrypted content when
 * `store` is off, which is always the case for ChatGPT.
 */
const PAYLOAD_PROVIDERS = new Set(["anthropic", "openai", "chatgpt"]);

/**
 * Moonshot thinking models reject an assistant tool-call message that lacks the
 * `reasoning_content` of its own turn.
 */
const MOONSHOT_POLICY: ReasoningReplayPolicy = { scope: "current-turn", textRequired: true };

/**
 * Mirrors the pinned `@ai-sdk/deepseek` rule for pre-V4 model ids: `deepseek-chat`,
 * `deepseek-reasoner` and `deepseek-v1` to `deepseek-v3` families. Every other id is treated
 * as V4 or later.
 */
const DEEPSEEK_LEGACY_MODEL_PATTERN =
  /(^|[/.])deepseek-(?:chat|reasoner|v[1-3](?:\.\d+)?)(?=[-/:.]|$)/;

export function isDeepSeekLegacyModel(modelName: string | undefined): boolean {
  return DEEPSEEK_LEGACY_MODEL_PATTERN.test(modelName ?? "");
}

/**
 * DeepSeek V4 and later expect `reasoning_content` on every assistant message, so reasoning
 * from earlier turns is replayed. Legacy ids only read it inside the current turn's tool loop.
 */
export function resolveReasoningReplay(
  providerName: string | undefined,
  modelName?: string,
): ReasoningReplayPolicy {
  const normalized = providerName?.toLowerCase();
  if (!normalized) {
    return NO_REPLAY;
  }
  if (PAYLOAD_PROVIDERS.has(normalized)) {
    return { scope: "current-turn", textRequired: false };
  }
  if (normalized === "moonshotai") {
    return MOONSHOT_POLICY;
  }
  if (normalized === "deepseek") {
    return {
      scope: isDeepSeekLegacyModel(modelName) ? "current-turn" : "all-turns",
      textRequired: true,
    };
  }
  return NO_REPLAY;
}
