/**
 * Find setup shortcuts for the home screen and agent-creation wizard. This module
 * reports which provider-key environment variables are present (names only, never
 * their values) and whether the configured or default Ollama server lists models.
 *
 * environmentKeyDetections supplies the first-run screen's detection labels.
 * ollamaOrigin normalizes the endpoint used by probeOllamaModels, whose bounded
 * /api/tags request enables the local-model shortcut without delaying startup.
 * Failed probes return undefined; callers keep the normal setup flow available.
 * These helpers detect existing setup; they do not create agents or save settings.
 */
import { LOCAL_SERVER_PROVIDERS } from "@jazz/core/constants/local-providers";
import { llmProviderEnvVars, LLM_PROVIDER_ENV_VARS } from "@jazz/core/constants/provider-env-vars";
import type { ActiveHomeDetection } from "../ui/store";

/** Ollama's default endpoint, used when no other base URL is known. */
const OLLAMA_DEFAULT_ORIGIN = LOCAL_SERVER_PROVIDERS.ollama.defaultUrl;

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
  if (baseUrl === undefined) {
    return OLLAMA_DEFAULT_ORIGIN;
  }
  try {
    return new URL(baseUrl).origin;
  } catch {
    return OLLAMA_DEFAULT_ORIGIN;
  }
}

/** The one fetch call the probe makes, so a test can stand in for the network. */
export type ProbeFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** How many models a running Ollama serves, or undefined when nothing answered in time. */
export async function probeOllamaModels(
  origin: string,
  fetchImpl: ProbeFetch = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`${origin}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { models?: unknown };
    return Array.isArray(body.models) ? body.models.length : undefined;
  } catch {
    return undefined;
  }
}
