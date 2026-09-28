import { describe, expect, it } from "bun:test";
import {
  SECRET_ENV_VARS,
  llmProviderApiKeyFromEnv,
  llmProviderEnvVars,
  secretValueFromEnv,
  SECRET_PATHS,
  envVarForSecretPath,
  isSecretPath,
  heldSecretPaths,
  isSecretEnvVarName,
  isWithheldEnvVarName,
  redactSecretValues,
  webhookTokenEnvVar,
  webhookTokenPath,
} from "./registry";
import { redactionPlaceholder } from "./secret-names";

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
    expect(envVarForSecretPath("llm.vllm.api_key")).toBe("VLLM_API_KEY");
    expect(envVarForSecretPath("llm.sglang.api_key")).toBe("SGLANG_API_KEY");
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
    expect(isSecretPath("telemetry.otlp.serviceName")).toBe(false);
    expect(isSecretPath("telemetry.enabled")).toBe(false);
  });

  it("checks the keyring for the OTLP authorization header on load", () => {
    expect(SECRET_PATHS).toContain("telemetry.otlp.headers.authorization");
  });

  it("checks the keyring for local-server API keys on load, even when the file has none", () => {
    expect(SECRET_PATHS).toContain("llm.ollama.api_key");
    expect(SECRET_PATHS).toContain("llm.vllm.api_key");
    expect(SECRET_PATHS).toContain("llm.sglang.api_key");
  });

  it("has no env var for OTLP headers, which OTEL_EXPORTER_OTLP_HEADERS supplies as a set", () => {
    expect(envVarForSecretPath("telemetry.otlp.headers.authorization")).toBeUndefined();
  });

  it("treats a webhook token as a secret", () => {
    expect(isSecretPath(webhookTokenPath("mira"))).toBe(true);
  });

  it("maps each webhook token path to the environment variable that overrides it", () => {
    expect(envVarForSecretPath(webhookTokenPath("mira"))).toBe("JAZZ_WEBHOOK_TOKEN_MIRA");
  });

  it("normalizes a webhook name into its environment variable", () => {
    expect(webhookTokenEnvVar("deploy-bot")).toBe("JAZZ_WEBHOOK_TOKEN_DEPLOY_BOT");
  });
});

describe("provider key aliases", () => {
  it("accepts GEMINI_API_KEY as well as the canonical Google variable", () => {
    // Google's own docs and CLI say GEMINI_API_KEY; the AI SDK reads
    // GOOGLE_GENERATIVE_AI_API_KEY. Somebody who exports the first has done nothing wrong.
    expect(llmProviderApiKeyFromEnv("gemini", { GEMINI_API_KEY: "from-alias" })).toBe("from-alias");
    expect(llmProviderApiKeyFromEnv("gemini", { GOOGLE_GENERATIVE_AI_API_KEY: "canonical" })).toBe(
      "canonical",
    );
  });

  it("prefers the canonical variable when both are set", () => {
    expect(
      llmProviderApiKeyFromEnv("gemini", {
        GOOGLE_GENERATIVE_AI_API_KEY: "canonical",
        GEMINI_API_KEY: "alias",
      }),
    ).toBe("canonical");
  });

  it("ignores an empty alias rather than treating it as a key", () => {
    expect(llmProviderApiKeyFromEnv("gemini", { GEMINI_API_KEY: "  " })).toBeUndefined();
  });

  it("resolves an aliased key through the generic secret path too", () => {
    // config.ts resolves by path, not by provider, so the alias has to work there or it only
    // works at the call sites that happen to ask by provider name.
    expect(secretValueFromEnv("llm.gemini.api_key", { GEMINI_API_KEY: "from-alias" })).toBe(
      "from-alias",
    );
    expect(secretValueFromEnv("llm.openai.api_key", { OPENAI_API_KEY: "sk" })).toBe("sk");
  });

  it("accepts NIM_API_KEY as well as the canonical NVIDIA variable", () => {
    expect(llmProviderApiKeyFromEnv("nvidia", { NIM_API_KEY: "from-alias" })).toBe("from-alias");
    expect(
      llmProviderApiKeyFromEnv("nvidia", { NVIDIA_API_KEY: "canonical", NIM_API_KEY: "alias" }),
    ).toBe("canonical");
    expect(secretValueFromEnv("llm.nvidia.api_key", { NIM_API_KEY: "from-alias" })).toBe(
      "from-alias",
    );
  });

  it("leaves providers without an alias alone", () => {
    expect(llmProviderEnvVars("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(llmProviderEnvVars("gemini")).toEqual([
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
    ]);
  });
});

describe("redactSecretValues", () => {
  it("redacts provider keys, tokens, OTLP headers and MCP env and header values", () => {
    const config = {
      llm: { openai: { api_key: "sk-live", base_url: "https://api.openai.com" } },
      daemon: { token: "daemon-token" },
      peers: { sam: { token: "peer-token", url: "https://sam.example" } },
      telemetry: { otlp: { headers: { "x-api-key": "otlp-key" } } },
      mcpServers: {
        "com.example.mcp": {
          command: "server",
          env: { SIGNOZ_API_KEY: "sk-signoz", LOG_LEVEL: "info" },
        },
        remote: { url: "https://mcp.example", headers: { Authorization: "Bearer t" } },
      },
      logging: { level: "info" },
    };

    expect(redactSecretValues(config)).toEqual({
      llm: {
        openai: {
          api_key: redactionPlaceholder("llm.openai.api_key"),
          base_url: "https://api.openai.com",
        },
      },
      daemon: { token: redactionPlaceholder("daemon.token") },
      peers: {
        sam: { token: redactionPlaceholder("peers.sam.token"), url: "https://sam.example" },
      },
      telemetry: {
        otlp: {
          headers: { "x-api-key": redactionPlaceholder("telemetry.otlp.headers.x-api-key") },
        },
      },
      mcpServers: {
        "com.example.mcp": {
          command: "server",
          env: {
            SIGNOZ_API_KEY: redactionPlaceholder("mcpServers.com.example.mcp.env.SIGNOZ_API_KEY"),
            LOG_LEVEL: redactionPlaceholder("mcpServers.com.example.mcp.env.LOG_LEVEL"),
          },
        },
        remote: {
          url: "https://mcp.example",
          headers: {
            Authorization: redactionPlaceholder("mcpServers.remote.headers.Authorization"),
          },
        },
      },
      logging: { level: "info" },
    });
  });

  it("redacts literal dotted MCP header and environment names in whole and partial configs", () => {
    const headers = { "X.Api.Key": "secret" };
    expect(
      redactSecretValues({
        mcpServers: { "com.example": { headers, env: { "vendor.key": "secret" } } },
      }),
    ).toEqual({
      mcpServers: {
        "com.example": {
          headers: {
            "X.Api.Key": redactionPlaceholder("mcpServers.com.example.headers.X.Api.Key"),
          },
          env: { "vendor.key": redactionPlaceholder("mcpServers.com.example.env.vendor.key") },
        },
      },
    });
    expect(redactSecretValues(headers, "mcpServers.com.example.headers")).toEqual({
      "X.Api.Key": redactionPlaceholder("mcpServers.com.example.headers.X.Api.Key"),
    });
    expect(redactSecretValues("secret", "mcpServers.com.example.headers.X.Api.Key")).toBe(
      redactionPlaceholder("mcpServers.com.example.headers.X.Api.Key"),
    );
  });

  it("redacts a single secret value looked up by its own path", () => {
    expect(redactSecretValues("sk-live", "llm.openai.api_key")).toBe(
      redactionPlaceholder("llm.openai.api_key"),
    );
    expect(redactSecretValues({ api_key: "sk-live" }, "llm.openai")).toEqual({
      api_key: redactionPlaceholder("llm.openai.api_key"),
    });
    expect(redactSecretValues("info", "logging.level")).toBe("info");
  });

  it("leaves empty values alone so a missing secret stays visible", () => {
    expect(redactSecretValues({ llm: { openai: { api_key: "" } } })).toEqual({
      llm: { openai: { api_key: "" } },
    });
  });
});

describe("secret environment variable names", () => {
  it("counts every variable Jazz reads a secret from, whatever its words", () => {
    expect(isSecretEnvVarName("JAZZ_NOTIFY_OPS_WEBHOOK_URL")).toBe(true);
    expect(isSecretEnvVarName("JAZZ_NOTIFY_PHONE_BOT_TOKEN")).toBe(true);
    expect(isSecretEnvVarName("JAZZ_NOTIFY_HOOK_SECRET")).toBe(true);
    expect(isSecretEnvVarName("JAZZ_PEER_TOKEN_SAM")).toBe(true);
    expect(isSecretEnvVarName("JAZZ_WEBHOOK_TOKEN_DEPLOY")).toBe(true);
    expect(isSecretEnvVarName("JAZZ_WEBHOOK_SECRET_DEPLOY")).toBe(true);
    expect(isSecretEnvVarName("JAZZ_DAEMON_TOKEN")).toBe(true);
    expect(isSecretEnvVarName("GEMINI_API_KEY")).toBe(true);
  });

  it("leaves Jazz's other variables alone", () => {
    expect(isSecretEnvVarName("JAZZ_HOME")).toBe(false);
    expect(isSecretEnvVarName("JAZZ_NOTIFY_OPS_URL")).toBe(false);
    expect(isWithheldEnvVarName("JAZZ_HOME")).toBe(false);
  });

  it("withholds from a child process any name with a secret word in it", () => {
    expect(isWithheldEnvVarName("JAZZ_NOTIFY_OPS_WEBHOOK_URL")).toBe(true);
    expect(isWithheldEnvVarName("GITHUB_TOKEN_FILE")).toBe(true);
    expect(isSecretEnvVarName("GITHUB_TOKEN_FILE")).toBe(false);
  });
});

describe("heldSecretPaths", () => {
  it("names every door, notify and daemon secret the config implies", () => {
    const paths = heldSecretPaths({
      llm: { custom: { api_key: "" } },
      peers: [{ name: "sam", url: "https://sam.example" }],
      webhooks: [{ name: "deploy", agentId: "a" }],
      notify: {
        targets: [
          { name: "ops", kind: "discord" },
          { name: "desk", kind: "desktop" },
        ],
      },
      telemetry: { otlp: { headers: { "x-honeycomb-team": "" } } },
    });
    expect(paths).toEqual(
      expect.arrayContaining([
        "llm.custom.api_key",
        "daemon.token",
        "daemon.operatorToken",
        "peers.sam.token",
        "webhooks.deploy.token",
        "webhooks.deploy.secret",
        "notify.targets.ops.webhookUrl",
        "notify.targets.ops.botToken",
        "telemetry.otlp.headers.x-honeycomb-team",
      ]),
    );
    expect(paths.some((path) => path.startsWith("notify.targets.desk."))).toBe(false);
    expect(paths.every(isSecretPath)).toBe(true);
  });
});
