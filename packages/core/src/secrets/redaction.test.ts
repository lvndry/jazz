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

/** A generous ceiling for redacting half a megabyte: a linear pass takes a few milliseconds. */
const LARGE_INPUT_BUDGET_MS = 200;

/** read_file returns up to this many characters in one result. */
const LARGE_INPUT_LENGTH = 500_000;

describe("redactSecretText on large input", () => {
  const inputs: readonly (readonly [string, string])[] = [
    ["a run of word characters", "a".repeat(LARGE_INPUT_LENGTH)],
    ["a base64 blob", "QUJDRA".repeat(LARGE_INPUT_LENGTH / 6)],
    ["a line of a= repeats", "a=".repeat(LARGE_INPUT_LENGTH / 2)],
    ["a line of a. repeats", "a.".repeat(LARGE_INPUT_LENGTH / 2)],
    ["a line of a: repeats", "a:".repeat(LARGE_INPUT_LENGTH / 2)],
    ["a line of quoted keys", '"a":'.repeat(LARGE_INPUT_LENGTH / 4)],
    ["JWT-like fragments", "eyJ-".repeat(LARGE_INPUT_LENGTH / 4)],
    ["URL-like fragments", "a://b:".repeat(LARGE_INPUT_LENGTH / 6)],
  ];

  for (const [label, text] of inputs) {
    it(`redacts ${label} within budget`, () => {
      const started = performance.now();
      redactSecretText(text, []);
      expect(performance.now() - started).toBeLessThan(LARGE_INPUT_BUDGET_MS);
    });
  }
});

describe("redactSecretText through terminal colour codes", () => {
  it("redacts coloured added, removed and context diff lines", () => {
    const lines = [
      "\x1b[32m+DB_PASSWORD=newsecretvalue\x1b[39m",
      "\x1b[31m-DB_PASSWORD=oldsecretvalue\x1b[39m",
      "\x1b[2m DB_PASSWORD=hunter2hunter2\x1b[22m",
      '\x1b[32m+  "apiKey": "abcdefgh12345",\x1b[39m',
      "\x1b[2m password: hunter2\x1b[22m",
    ];
    expect(redactSecretText(lines.join("\n"), [])).toBe(
      [
        "\x1b[32m+DB_PASSWORD=[redacted:DB_PASSWORD]\x1b[39m",
        "\x1b[31m-DB_PASSWORD=[redacted:DB_PASSWORD]\x1b[39m",
        "\x1b[2m DB_PASSWORD=[redacted:DB_PASSWORD]\x1b[22m",
        '\x1b[32m+  "apiKey": "[redacted:apiKey]",\x1b[39m',
        "\x1b[2m password: [redacted:password]\x1b[22m",
      ].join("\n"),
    );
  });
});

describe("redactSecretText on private keys", () => {
  it("redacts a private key block whose end marker was cut off", () => {
    const text = "config:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nb3BlbnNzaC1r";
    expect(redactSecretText(text, [])).toBe("config:\n[redacted:private-key]");
  });
});

describe("redactSecretText on secret names", () => {
  it("redacts every secret-named assignment", () => {
    const text = [
      "APP_KEY=base64:abcdef",
      "ENCRYPTION_KEY=0123abcd",
      "JWT_KEY=signing",
      "SESSION_KEY=sessionvalue",
      "DB_PASS=hunter2",
      "NPM_AUTH=authvalue",
      "SECRET_KEY_BASE=railsvalue",
      "JAZZ_NOTIFY_OPS_WEBHOOK_URL=anything-at-all",
    ].join("\n");
    expect(redactSecretText(text, [])).toBe(
      [
        "APP_KEY=[redacted:APP_KEY]",
        "ENCRYPTION_KEY=[redacted:ENCRYPTION_KEY]",
        "JWT_KEY=[redacted:JWT_KEY]",
        "SESSION_KEY=[redacted:SESSION_KEY]",
        "DB_PASS=[redacted:DB_PASS]",
        "NPM_AUTH=[redacted:NPM_AUTH]",
        "SECRET_KEY_BASE=[redacted:SECRET_KEY_BASE]",
        "JAZZ_NOTIFY_OPS_WEBHOOK_URL=[redacted:JAZZ_NOTIFY_OPS_WEBHOOK_URL]",
      ].join("\n"),
    );
  });

  it("redacts unquoted YAML values under secret names", () => {
    const text = [
      "db:",
      "  password: hunter2",
      "services:",
      "  db:",
      "    environment:",
      "      POSTGRES_PASSWORD: x",
      "      - MYSQL_PASSWORD=y",
    ].join("\n");
    expect(redactSecretText(text, [])).toBe(
      [
        "db:",
        "  password: [redacted:password]",
        "services:",
        "  db:",
        "    environment:",
        "      POSTGRES_PASSWORD: [redacted:POSTGRES_PASSWORD]",
        "      - MYSQL_PASSWORD=[redacted:MYSQL_PASSWORD]",
      ].join("\n"),
    );
  });

  it("redacts a kubeconfig token, a docker auth and a JSON-escaped key", () => {
    expect(redactSecretText("    token: abc123def456", [])).toBe("    token: [redacted:token]");
    expect(redactSecretText('{"auths":{"ghcr.io":{"auth":"dXNlcjpwYXNzd29yZA=="}}}', [])).toBe(
      '{"auths":{"ghcr.io":{"auth":"[redacted:auth]"}}}',
    );
    expect(redactSecretText('{\\"api_key\\":\\"abcdefgh12345\\"}', [])).toBe(
      '{\\"api_key\\":\\"[redacted:api_key]\\"}',
    );
  });

  it("redacts .netrc passwords", () => {
    expect(redactSecretText("machine api.example.com login me password s3cr3tvalue", [])).toBe(
      "machine api.example.com login me password [redacted:password]",
    );
    expect(redactSecretText("machine example.com\n  login me\n  password s3cr3t", [])).toBe(
      "machine example.com\n  login me\n  password [redacted:password]",
    );
  });

  it("redacts JWTs anywhere", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactSecretText(`id_token ${jwt} end`, [])).toBe("id_token [redacted:jwt] end");
  });

  it("redacts Discord and Slack webhook URLs", () => {
    expect(
      redactSecretText("url https://discord.com/api/webhooks/1234567890/AbC-dEf_GhI end", []),
    ).toBe("url [redacted:discord-webhook] end");
    expect(
      redactSecretText("url https://hooks.slack.com/services/T0001/B0001/XXXXYYYYZZZZ end", []),
    ).toBe("url [redacted:slack-webhook] end");
  });

  it("leaves names that only contain a secret word, references, paths and fill-ins alone", () => {
    const text = [
      "KEYBOARD_LAYOUT=us",
      "MONKEY=banana",
      "TOKENIZER_PATH=/x",
      "TOKEN_URL=https://auth.example.com/token",
      "SORT_KEY=createdAt",
      "API_TOKEN=$OTHER",
      "API_TOKEN=${OTHER}",
      "API_TOKEN=",
      "API_TOKEN=<your-token-here>",
      "API_TOKEN=xxxxxxxx",
      "API_TOKEN=[redacted:API_TOKEN]",
      "GITHUB_TOKEN_FILE=/run/secrets/token",
      "use_auth: true",
      "token_type: Bearer",
      "max_tokens: 4096",
      "Password: see the team vault for details",
      "Enter your password below",
    ].join("\n");
    expect(redactSecretText(text, [])).toBe(text);
  });
});

describe("redactSecretsDeep by key", () => {
  it("redacts strings under secret-named keys in nested objects and arrays", () => {
    expect(
      redactSecretsDeep(
        {
          status: 200,
          body: {
            access_token: "ya29.a0AfH6SMBxyz",
            refresh_token: "1//0gLongRefresh",
            token_type: "Bearer",
            expires_in: 3599,
            accounts: [{ name: "me", clientSecret: "short" }],
          },
          structuredContent: { items: [{ password: "p", note: "hello" }] },
        },
        [],
      ),
    ).toEqual({
      status: 200,
      body: {
        access_token: "[redacted:access_token]",
        refresh_token: "[redacted:refresh_token]",
        token_type: "Bearer",
        expires_in: 3599,
        accounts: [{ name: "me", clientSecret: "[redacted:clientSecret]" }],
      },
      structuredContent: { items: [{ password: "[redacted:password]", note: "hello" }] },
    });
  });

  it("keeps empty values and references under secret-named keys", () => {
    expect(redactSecretsDeep({ token: "", apiKey: "$OPENAI_API_KEY" }, [])).toEqual({
      token: "",
      apiKey: "$OPENAI_API_KEY",
    });
  });
});

describe("collectKnownSecrets for held and MCP secrets", () => {
  it("takes secrets Jazz holds outside the config", () => {
    const known = collectKnownSecrets({}, {}, [
      { name: "peers.sam.token", value: "peer-token-0123456789" },
    ]);
    expect(known).toEqual([{ name: "peers.sam.token", value: "peer-token-0123456789" }]);
  });

  it("knows an MCP env or header value only when its name says secret", () => {
    const known = collectKnownSecrets(
      {
        mcpServers: {
          signoz: {
            env: {
              SIGNOZ_API_KEY: "sk-signoz-0123456789",
              DEPLOY_ENV: "production",
              WORKDIR: "/Users/me/code",
            },
            headers: { Authorization: "Bearer abcdefgh", "Content-Type": "application/json" },
          },
        },
      },
      {},
    );
    expect(known).toEqual([
      { name: "mcpServers.signoz.env.SIGNOZ_API_KEY", value: "sk-signoz-0123456789" },
      { name: "mcpServers.signoz.headers.Authorization", value: "Bearer abcdefgh" },
    ]);
  });

  it("skips config secrets that are paths", () => {
    expect(
      collectKnownSecrets({ llm: { custom: { api_key: "/run/secrets/custom-key" } } }, {}),
    ).toEqual([]);
  });

  it("knows Jazz's own secret environment variables", () => {
    expect(
      collectKnownSecrets({}, { JAZZ_NOTIFY_OPS_WEBHOOK_URL: "https://discord.com/api/x/y" }),
    ).toEqual([{ name: "JAZZ_NOTIFY_OPS_WEBHOOK_URL", value: "https://discord.com/api/x/y" }]);
  });
});
