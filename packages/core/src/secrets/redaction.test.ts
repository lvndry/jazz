import { describe, expect, it } from "bun:test";
import {
  collectKnownSecrets,
  containsRedactionPlaceholder,
  redactSecretText,
  redactSecretsDeep,
} from "./redaction";

const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";

describe("collectKnownSecrets", () => {
  it("takes values at secret config paths and secret-named environment variables", () => {
    const known = collectKnownSecrets(
      {
        llm: { openai: { api_key: OPENAI_KEY }, ollama: { base_url: "http://localhost:11434" } },
        daemon: { token: "daemon-token-0123456789" },
        maxTokens: 4096,
      },
      { GITHUB_TOKEN: "ghs_custom_value_123", HOME: "/Users/someone", EDITOR: "vim-editor" },
    );
    expect(known).toEqual([
      { name: "llm.openai.api_key", value: OPENAI_KEY },
      { name: "daemon.token", value: "daemon-token-0123456789" },
      { name: "GITHUB_TOKEN", value: "ghs_custom_value_123" },
    ]);
  });

  it("skips short values and paths, which would match ordinary text", () => {
    const known = collectKnownSecrets(
      {},
      {
        SHORT_TOKEN: "abc",
        GOOGLE_APPLICATION_CREDENTIALS: "/home/me/creds.json",
        TOKENIZERS_PARALLELISM: "false-but-long",
        MAX_TOKENS: "1234567890",
      },
    );
    expect(known).toEqual([]);
  });
});

describe("redactSecretText", () => {
  it("replaces a known value wherever it appears, named by where Jazz holds it", () => {
    const known = [{ name: "daemon.token", value: "daemon-token-0123456789" }];
    expect(redactSecretText("curl -H 'X: daemon-token-0123456789' localhost", known)).toBe(
      "curl -H 'X: [redacted:daemon.token]' localhost",
    );
  });

  it("redacts .env and shell profile assignments, keeping the name", () => {
    const text = [
      "OPENAI_API_KEY=abc123notashape",
      "export DB_PASSWORD='hunter2'",
      'STRIPE_SECRET_KEY="xyz-789"',
      "DEBUG=true",
      "GITHUB_TOKEN=$GH_TOKEN",
      "DATABASE_URL=postgres://app:s3cret@db:5432/app",
    ].join("\n");
    expect(redactSecretText(text, [])).toBe(
      [
        "OPENAI_API_KEY=[redacted:OPENAI_API_KEY]",
        "export DB_PASSWORD='[redacted:DB_PASSWORD]'",
        'STRIPE_SECRET_KEY="[redacted:STRIPE_SECRET_KEY]"',
        "DEBUG=true",
        "GITHUB_TOKEN=$GH_TOKEN",
        "DATABASE_URL=postgres://app:[redacted:password]@db:5432/app",
      ].join("\n"),
    );
  });

  it("redacts assignments behind read_file and cat -n line numbers", () => {
    expect(redactSecretText("1|HOME=/x\n2|API_TOKEN=plainvalue", [])).toBe(
      "1|HOME=/x\n2|API_TOKEN=[redacted:API_TOKEN]",
    );
    expect(redactSecretText("     3\tAWS_SECRET_ACCESS_KEY=abcd", [])).toBe(
      "     3\tAWS_SECRET_ACCESS_KEY=[redacted:AWS_SECRET_ACCESS_KEY]",
    );
  });

  it("redacts assignments on diff and compose list lines", () => {
    expect(
      redactSecretText("-API_TOKEN=oldvalue\n+API_TOKEN=newvalue\n - DB_PASSWORD=x1", []),
    ).toBe(
      "-API_TOKEN=[redacted:API_TOKEN]\n+API_TOKEN=[redacted:API_TOKEN]\n - DB_PASSWORD=[redacted:DB_PASSWORD]",
    );
  });

  it("redacts quoted secret-named literals in JSON, YAML and source", () => {
    expect(redactSecretText('{ "apiKey": "abcdefgh12345", "model": "gpt-5.4" }', [])).toBe(
      '{ "apiKey": "[redacted:apiKey]", "model": "gpt-5.4" }',
    );
    expect(redactSecretText("client_secret: 'longsecretvalue'", [])).toBe(
      "client_secret: '[redacted:client_secret]'",
    );
    expect(redactSecretText('const openaiApiKey = "abcdefgh12345";', [])).toBe(
      'const openaiApiKey = "[redacted:openaiApiKey]";',
    );
  });

  it("redacts recognizable key formats and credential blocks anywhere", () => {
    const text = [
      `key ${OPENAI_KEY}`,
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "Authorization: Bearer abcdefghijklmnop1234",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    expect(redactSecretText(text, [])).toBe(
      [
        "key [redacted:api-key]",
        "[redacted:github-token]",
        "[redacted:aws-key]",
        "Authorization: Bearer [redacted:credential]",
        "[redacted:private-key]",
      ].join("\n"),
    );
  });

  it("leaves ordinary code and configuration alone", () => {
    const text = [
      "const token = getToken();",
      'tokenizer: "cl100k_base"',
      '"cwd": "/Users/me/project"',
      '"credentials": "/home/me/creds.json"',
      "maxTokens: 4096",
      "PATH=/usr/bin:/bin",
      "risk-assessment-for-the-long-running-task",
      "https://example.com/docs",
    ].join("\n");
    expect(redactSecretText(text, [])).toBe(text);
  });

  it("is stable when run over its own output", () => {
    const once = redactSecretText(`TOKEN=abc123\nBearer abcdefghijklmnop1234\n${OPENAI_KEY}`, []);
    expect(redactSecretText(once, [])).toBe(once);
    expect(containsRedactionPlaceholder(once)).toBe(true);
  });
});

describe("redactSecretsDeep", () => {
  it("redacts every string in a tool result and keeps its shape", () => {
    const known = [{ name: "llm.openai.api_key", value: OPENAI_KEY }];
    expect(
      redactSecretsDeep(
        { content: `1|OPENAI_API_KEY=${OPENAI_KEY}`, lines: [OPENAI_KEY, 3], ok: true },
        known,
      ),
    ).toEqual({
      content: "1|OPENAI_API_KEY=[redacted:llm.openai.api_key]",
      lines: ["[redacted:llm.openai.api_key]", 3],
      ok: true,
    });
  });

  it("returns binary data untouched", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const redacted = redactSecretsDeep({ bytes }, []);
    expect(redacted.bytes).toBe(bytes);
  });
});
