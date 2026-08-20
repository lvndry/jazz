/**
 * @fileoverview Which providers serve models from this machine
 *
 * Two attachment rules bend for local providers, and both for the same reason: the limits they
 * relax are *network* limits. A local model has no request-size cap to respect and no file API
 * to upload to, so a size ceiling copied from Anthropic's API would reject a file that would
 * have worked fine.
 */

/** Providers whose models run on the local machine. */
const LOCAL_PROVIDERS = new Set(["ollama", "llamacpp"]);

export function isLocalProvider(providerName: string): boolean {
  return LOCAL_PROVIDERS.has(providerName.toLowerCase());
}
