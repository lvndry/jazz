// Ollama truncates to a small runtime context (~4096) unless num_ctx is set, so
// agents pick from this ladder, capped to the model's real maximum.
const OLLAMA_CONTEXT_WINDOW_LADDER = [4096, 8192, 16384, 32768, 65536, 131072] as const;
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

// The exact detected max is always offered, even between ladder rungs, so the
// model's full context stays reachable.
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

export function defaultOllamaContextWindow(detectedContextWindow?: number): number {
  if (typeof detectedContextWindow !== "number" || detectedContextWindow <= 0) {
    return OLLAMA_DEFAULT_CONTEXT_WINDOW;
  }
  return Math.min(OLLAMA_DEFAULT_CONTEXT_WINDOW, detectedContextWindow);
}
