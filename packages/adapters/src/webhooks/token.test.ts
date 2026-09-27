import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { resolveWebhookSecret, resolveWebhookToken } from "./token";

const ENV_VAR = "JAZZ_WEBHOOK_TOKEN_DEPLOYS";

async function resolve(env: Record<string, string | undefined>): Promise<string | undefined> {
  const saved = process.env[ENV_VAR];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await Effect.runPromise(resolveWebhookToken("deploys"));
  } finally {
    if (saved === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved;
  }
}

describe("resolving a webhook's bearer token", () => {
  it("reads the environment variable", async () => {
    expect(await resolve({ [ENV_VAR]: "from-env" })).toBe("from-env");
  });

  it("trims surrounding whitespace", async () => {
    expect(await resolve({ [ENV_VAR]: "  padded  " })).toBe("padded");
  });

  it("falls through to the keyring when the variable is blank", async () => {
    // No keyring entry exists for this name under test, so the blank value must not be
    // returned as though it were the token.
    expect(await resolve({ [ENV_VAR]: "   " })).toBeUndefined();
  });
});

describe("resolving a webhook's signing secret", () => {
  it("reads its own variable, apart from the bearer token's", async () => {
    const secretVar = "JAZZ_WEBHOOK_SECRET_DEPLOYS";
    const saved = { token: process.env[ENV_VAR], secret: process.env[secretVar] };
    process.env[ENV_VAR] = "the-token";
    process.env[secretVar] = "the-secret";
    try {
      expect(await Effect.runPromise(resolveWebhookSecret("deploys"))).toBe("the-secret");
    } finally {
      for (const [key, value] of [
        [ENV_VAR, saved.token],
        [secretVar, saved.secret],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
