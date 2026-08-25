/**
 * @fileoverview The merge rule for a bridge's `config.json`.
 *
 * Kept pure and separate from the entrypoint script that applies it: the
 * interesting part is which keys the bridge owns and what happens when their
 * environment variables go away, and that is worth testing without a filesystem.
 */

export type JsonObject = Record<string, unknown>;

/** The environment variables a bridge translates into config keys. */
export interface BridgeConfigEnv {
  readonly braveApiKey?: string | undefined;
  readonly ollamaKeepAlive?: string | undefined;
}

function nestedObject(config: JsonObject, key: string): JsonObject {
  const existing = config[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    return { ...(existing as JsonObject) };
  }
  return {};
}

/**
 * Apply the bridge-managed keys to `existing`, returning a new object.
 *
 * Only the managed keys are touched; everything else the operator put in the file
 * is passed through, since the data volume outlives the container.
 *
 * A managed key whose variable is unset is *removed* rather than left behind, so
 * turning an integration off in the environment actually takes effect instead of
 * persisting from an earlier run.
 */
export function mergeBridgeConfig(
  existing: JsonObject,
  env: BridgeConfigEnv,
): { config: JsonObject; applied: readonly string[] } {
  const config: JsonObject = { ...existing };
  const applied: string[] = [];

  if (env.braveApiKey) {
    config["web_search"] = {
      ...nestedObject(config, "web_search"),
      provider: "brave",
      brave: { api_key: env.braveApiKey },
    };
    applied.push("web_search=brave");
  } else {
    delete config["web_search"];
  }

  const llm = nestedObject(config, "llm");
  if (env.ollamaKeepAlive) {
    llm["ollama"] = { ...nestedObject(llm, "ollama"), keep_alive: env.ollamaKeepAlive };
    applied.push(`ollama.keep_alive=${env.ollamaKeepAlive}`);
  } else {
    const ollama = nestedObject(llm, "ollama");
    delete ollama["keep_alive"];
    if (Object.keys(ollama).length > 0) {
      llm["ollama"] = ollama;
    } else {
      delete llm["ollama"];
    }
  }
  if (Object.keys(llm).length > 0) {
    config["llm"] = llm;
  } else {
    delete config["llm"];
  }

  return { config, applied };
}
