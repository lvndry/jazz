/**
 * Ollama model discovery, shared by the Discord and Telegram bridges.
 *
 * Ollama is the only provider Jazz's bridges can introspect for free — its
 * local HTTP API lists installed models and their capabilities without an
 * API key or a network round-trip to a hosted catalog, which is why `/model`
 * offers it as a live picker. Any other provider Jazz supports (OpenAI,
 * Anthropic, OpenRouter, ...) still works, just via an explicit
 * `provider/model` argument rather than a browsable list — see each bridge's
 * `/model` handling.
 */

export async function listOllamaModels(ollamaBaseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${ollamaBaseUrl}/tags`);
    const data = (await response.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string");
    return names.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    console.error(`Failed to list Ollama models: ${String(error)}`);
    return [];
  }
}

/** True if the model advertises a "thinking" capability (so reasoning is safe to enable). */
export async function modelSupportsThinking(
  ollamaBaseUrl: string,
  model: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${ollamaBaseUrl}/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, name: model }),
    });
    const data = (await response.json()) as { capabilities?: string[] };
    return Array.isArray(data.capabilities) && data.capabilities.includes("thinking");
  } catch (error) {
    console.error(`Failed to probe model capabilities for ${model}: ${String(error)}`);
    return false;
  }
}
