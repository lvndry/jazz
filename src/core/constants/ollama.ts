/**
 * Ollama caps the *runtime* context window (`num_ctx`) to a small default
 * (~4096 tokens) regardless of the model's trained size, silently truncating
 * long conversations. Jazz therefore lets each Ollama agent pick its context
 * window explicitly from a fixed ladder, capped to the model's real maximum.
 */
const OLLAMA_CONTEXT_WINDOW_LADDER = [4096, 8192, 16384, 32768, 65536, 131072] as const;

/** Preferred default context window when the model can accommodate it. */
const OLLAMA_DEFAULT_CONTEXT_WINDOW = 32768;

export interface ContextWindowChoice {
  readonly name: string;
  readonly value: number;
}

function formatTokenCount(tokens: number): string {
  if (tokens % 1024 === 0) {
    return `${tokens / 1024}K`;
  }
  return `${tokens}`;
}

/**
 * Build the selectable context-window options for an Ollama agent, capped to the
 * model's detected maximum. The exact model maximum is always offered (even when
 * it falls between ladder rungs) so users can use the model's full context.
 */
export function buildOllamaContextChoices(detectedContextWindow?: number): ContextWindowChoice[] {
  const max =
    typeof detectedContextWindow === "number" && detectedContextWindow > 0
      ? detectedContextWindow
      : undefined;

  const values: number[] = OLLAMA_CONTEXT_WINDOW_LADDER.filter((value) => !max || value <= max);
  if (max && !values.includes(max)) {
    values.push(max);
  }
  if (values.length === 0) {
    values.push(max ?? OLLAMA_CONTEXT_WINDOW_LADDER[0]);
  }

  const unique = Array.from(new Set(values)).sort((first, second) => first - second);
  return unique.map((value) => ({
    value,
    name:
      max && value === max
        ? `${formatTokenCount(value)} — ${value.toLocaleString()} tokens (model maximum)`
        : `${formatTokenCount(value)} — ${value.toLocaleString()} tokens`,
  }));
}

/**
 * The recommended default selection: the preferred window, clamped to what the
 * model actually supports. Always coincides with one of the built choices.
 */
export function defaultOllamaContextWindow(detectedContextWindow?: number): number {
  if (typeof detectedContextWindow !== "number" || detectedContextWindow <= 0) {
    return OLLAMA_DEFAULT_CONTEXT_WINDOW;
  }
  return Math.min(OLLAMA_DEFAULT_CONTEXT_WINDOW, detectedContextWindow);
}
