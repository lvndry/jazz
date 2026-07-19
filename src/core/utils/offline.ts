/**
 * Offline / airgapped mode.
 *
 * When JAZZ_OFFLINE is set ("1" or "true"), Jazz never initiates outbound
 * network requests on its own: the models.dev catalog fetch and the npm
 * update check are skipped. Inference still goes to whatever provider the
 * agent is configured with — in an airgapped deployment that is a local
 * server such as Ollama (OLLAMA_BASE_URL) or llama.cpp (LLAMACPP_BASE_URL).
 */
export function isOfflineMode(): boolean {
  const value = process.env["JAZZ_OFFLINE"];
  return value === "1" || value === "true";
}
