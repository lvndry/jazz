import { describe, expect, it } from "bun:test";
import {
  SECRET_ENV_VARS,
  SECRET_PATHS,
  envVarForSecretPath,
  isSecretPath,
  legacyTriggerTokenEnvVar,
  webhookTokenEnvVar,
  webhookTokenPath,
} from "./registry";

describe("secret registry", () => {
  it("treats known LLM, web search, and Google secret paths as secrets", () => {
    expect(isSecretPath("llm.openai.api_key")).toBe(true);
    expect(isSecretPath("web_search.brave.api_key")).toBe(true);
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
    expect(envVarForSecretPath("llm.gemini.api_key")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(envVarForSecretPath("llm.ollama.api_key")).toBe("OLLAMA_API_KEY");
    expect(envVarForSecretPath("web_search.exa.api_key")).toBe("EXA_API_KEY");
    expect(envVarForSecretPath("logging.level")).toBeUndefined();
  });

  it("gives every registered secret path a distinct environment variable", () => {
    const envVars = Object.values(SECRET_ENV_VARS);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("treats OTLP export headers as secrets", () => {
    // These carry the collector credential (e.g. a Langfuse key pair).
    expect(isSecretPath("telemetry.otlp.headers.authorization")).toBe(true);
    expect(isSecretPath("telemetry.otlp.headers.x-api-key")).toBe(true);
  });

  it("does not treat non-header telemetry settings as secrets", () => {
    expect(isSecretPath("telemetry.otlp.endpoint")).toBe(false);
    expect(isSecretPath("telemetry.otlp.captureContent")).toBe(false);
    expect(isSecretPath("telemetry.enabled")).toBe(false);
  });

  it("checks the keyring for the OTLP authorization header on load", () => {
    expect(SECRET_PATHS).toContain("telemetry.otlp.headers.authorization");
  });

  it("checks the keyring for an Ollama API key on load, even when the file has none", () => {
    expect(SECRET_PATHS).toContain("llm.ollama.api_key");
  });

  it("has no env var for OTLP headers, which OTEL_EXPORTER_OTLP_HEADERS supplies as a set", () => {
    expect(envVarForSecretPath("telemetry.otlp.headers.authorization")).toBeUndefined();
  });

  it("treats a webhook token as a secret under both its current and pre-rename path", () => {
    expect(isSecretPath(webhookTokenPath("mira"))).toBe(true);
    expect(isSecretPath("triggers.mira.token")).toBe(true);
  });

  it("maps each webhook token path to the environment variable that overrides it", () => {
    expect(envVarForSecretPath(webhookTokenPath("mira"))).toBe("JAZZ_WEBHOOK_TOKEN_MIRA");
    expect(envVarForSecretPath("triggers.mira.token")).toBe("JAZZ_TRIGGER_TOKEN_MIRA");
  });

  it("derives both webhook token variables from the same normalized name", () => {
    expect(webhookTokenEnvVar("deploy-bot")).toBe("JAZZ_WEBHOOK_TOKEN_DEPLOY_BOT");
    expect(legacyTriggerTokenEnvVar("deploy-bot")).toBe("JAZZ_TRIGGER_TOKEN_DEPLOY_BOT");
  });
});
