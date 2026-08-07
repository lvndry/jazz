import { LOCAL_SERVER_PROVIDERS } from "@/core/constants/local-providers";

/**
 * Where a local model's advertised maximum and its runtime window diverge.
 *
 * A cloud provider honours the window its catalog advertises, so the advertised
 * number is the real one. A local server does not: Ollama loads a model with
 * `num_ctx` (per request) or `OLLAMA_CONTEXT_LENGTH` (server default), both far
 * below what the weights support, and llama-server is fixed at its `-c` value.
 * Accounting against the advertised maximum makes Jazz compact too late and lets
 * the server silently drop the middle of the conversation instead — the run keeps
 * going, from a context it no longer has.
 */

export type ContextWindowSource = "pinned" | "server" | "model-max";

export interface EffectiveContextWindow {
  /** Tokens the server will actually honour. Use this for compaction accounting. */
  readonly tokens: number;
  readonly source: ContextWindowSource;
  /** What the catalog (or the model file) advertises, for surfacing the shortfall. */
  readonly modelMaxTokens: number;
}

export interface EffectiveContextWindowInput {
  readonly provider: string;
  readonly modelMaxTokens: number;
  /** `config.numCtx`, sent as `options.num_ctx`; overrides the server default per request. */
  readonly pinnedContextWindow?: number;
  /** Window the local server reported for the loaded model, when it is known. */
  readonly serverContextWindow?: number;
}

export function isLocalServerProvider(provider: string): boolean {
  return provider in LOCAL_SERVER_PROVIDERS;
}

function positiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the context window to account against. Cloud providers always get their
 * advertised window; local providers get the smaller runtime window whenever one
 * is known, since a pinned `num_ctx` above the model maximum still cannot buy more
 * context than the weights support.
 */
export function resolveEffectiveContextWindow(
  input: EffectiveContextWindowInput,
): EffectiveContextWindow {
  const modelMaxTokens = input.modelMaxTokens;
  if (!isLocalServerProvider(input.provider)) {
    return { tokens: modelMaxTokens, source: "model-max", modelMaxTokens };
  }

  const pinned = positiveTokenCount(input.pinnedContextWindow);
  if (pinned !== undefined) {
    return { tokens: Math.min(pinned, modelMaxTokens), source: "pinned", modelMaxTokens };
  }

  const server = positiveTokenCount(input.serverContextWindow);
  if (server !== undefined) {
    return { tokens: Math.min(server, modelMaxTokens), source: "server", modelMaxTokens };
  }

  return { tokens: modelMaxTokens, source: "model-max", modelMaxTokens };
}

/**
 * Warn when a local agent is accounting against a window nobody promised.
 *
 * Ollama exposes a loaded model's real window on `/api/ps`, but only while it is
 * loaded and only for whatever `num_ctx` the last caller asked for — there is no
 * endpoint for the server's configured default. So an unpinned local agent cannot
 * be told what it will get, and the honest move is to say so rather than to keep
 * quietly assuming the maximum.
 */
export function describeContextWindowShortfall(
  provider: string,
  effective: EffectiveContextWindow,
): string | null {
  if (!isLocalServerProvider(provider) || effective.source !== "model-max") {
    return null;
  }
  return (
    `No context window is pinned for this ${provider} agent, so Jazz is compacting against the ` +
    `model maximum (${effective.modelMaxTokens.toLocaleString()} tokens). If the server runs a ` +
    `smaller window it will truncate the conversation instead. Pin one with \`jazz agent edit\` → Context Window.`
  );
}
