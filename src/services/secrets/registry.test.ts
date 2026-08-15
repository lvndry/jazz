import { describe, expect, it } from "bun:test";
import { SECRET_ENV_VARS, envVarForSecretPath, isSecretPath } from "./registry";

describe("secret registry", () => {
  it("treats known LLM, web search, and Google secret paths as secrets", () => {
    expect(isSecretPath("llm.openai.api_key")).toBe(true);
    expect(isSecretPath("web_search.brave.api_key")).toBe(true);
    expect(isSecretPath("google.clientSecret")).toBe(true);
    expect(isSecretPath("google.clientId")).toBe(true);
  });

  it("treats unknown providers as secrets so new keys are never left in plaintext", () => {
    expect(isSecretPath("llm.some_future_provider.api_key")).toBe(true);
    expect(isSecretPath("web_search.some_future_provider.api_key")).toBe(true);
  });

  it("does not treat ordinary config paths as secrets", () => {
    expect(isSecretPath("logging.level")).toBe(false);
    expect(isSecretPath("web_search.provider")).toBe(false);
    expect(isSecretPath("llm.openai.base_url")).toBe(false);
    expect(isSecretPath("storage.path")).toBe(false);
  });

  it("maps secret paths to their environment variables", () => {
    expect(envVarForSecretPath("llm.anthropic.api_key")).toBe("ANTHROPIC_API_KEY");
    expect(envVarForSecretPath("llm.google.api_key")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(envVarForSecretPath("web_search.exa.api_key")).toBe("EXA_API_KEY");
    expect(envVarForSecretPath("google.clientSecret")).toBe("GOOGLE_CLIENT_SECRET");
    expect(envVarForSecretPath("logging.level")).toBeUndefined();
  });

  it("gives every registered secret path a distinct environment variable", () => {
    const envVars = Object.values(SECRET_ENV_VARS);
    expect(new Set(envVars).size).toBe(envVars.length);
  });
});
