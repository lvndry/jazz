import { llmProviderEnvVars, LLM_PROVIDER_ENV_VARS } from "@jazz/core/constants/provider-env-vars";
import type { ActiveHomeDetection } from "../ui/store";

/** Ollama's default endpoint, used when no other base URL is known. */
const OLLAMA_DEFAULT_ORIGIN = "http://127.0.0.1:11434";

/**
 * How long the first-run screen waits for a local Ollama to answer. A server on this machine
 * answers in a few milliseconds; past this it is not running, and the screen must not stall.
 */
const OLLAMA_PROBE_TIMEOUT_MS = 400;

/** Provider API keys already exported in the environment, as first-run detections. */
export function environmentKeyDetections(
  environment: NodeJS.ProcessEnv = process.env,
): ActiveHomeDetection[] {
  const detections: ActiveHomeDetection[] = [];
  for (const provider of Object.keys(LLM_PROVIDER_ENV_VARS)) {
    const variable = llmProviderEnvVars(provider).find((name) => environment[name]?.trim());
    if (variable !== undefined) {
      detections.push({ label: variable, detail: "in your environment" });
    }
  }
  return detections;
}

/** The origin an Ollama base URL points at, or the default when none is configured. */
export function ollamaOrigin(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return OLLAMA_DEFAULT_ORIGIN;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return OLLAMA_DEFAULT_ORIGIN;
  }
}

/** How many models a running Ollama serves, or undefined when nothing answered in time. */
export async function probeOllamaModels(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`${origin}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { models?: unknown };
    return Array.isArray(body.models) ? body.models.length : undefined;
  } catch {
    return undefined;
  }
}
