/**
 * Guard replay of private conversation data before any provider discovery or inference.
 * Check both production model selections with assertVllmReplayProviders, then pass the
 * effective provider URL to validateVllmReplayEndpoint. Only loopback IP literals are
 * local; hostnames, including localhost, require explicit remote consent. URL parsing
 * canonicalizes alternate IPv4 forms before classification. Returned origins omit paths
 * and queries so callers can disclose the destination without exposing endpoint secrets.
 */
import { isIP } from "node:net";
import { selectSummarizerModel } from "@jazz/core/agent/context/summarizer";
import type { Agent } from "@jazz/core/types/agent";

/** Reject a primary or selected summarizer provider outside the experiment's vLLM adapter. */
export function assertVllmReplayProviders(agent: Agent): void {
  if (
    agent.config.llm.provider !== "vllm" ||
    selectSummarizerModel(agent).config.provider !== "vllm"
  ) {
    throw new Error("Compaction replay requires both primary and summarizer providers to be vLLM");
  }
}

/** Validate actual routing; remote consent never permits credentials or a non-HTTP endpoint. */
export function validateVllmReplayEndpoint(
  baseUrl: string,
  options: { readonly allowRemote?: boolean } = {},
): { readonly origin: string; readonly isLoopback: boolean } {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error("Invalid vLLM replay endpoint URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The vLLM replay endpoint must use HTTP or HTTPS");
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new Error("The vLLM replay endpoint must not contain URL credentials");
  }
  const isLoopback =
    (isIP(endpoint.hostname) === 4 && endpoint.hostname.startsWith("127.")) ||
    endpoint.hostname === "[::1]";
  if (!isLoopback && options.allowRemote !== true) {
    throw new Error("The vLLM replay endpoint is remote; --allow-remote is required");
  }
  return { origin: endpoint.origin, isLoopback };
}
