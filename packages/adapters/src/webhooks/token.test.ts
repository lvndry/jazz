import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { resolveWebhookToken } from "./token";

const NEW_ENV_VAR = "JAZZ_WEBHOOK_TOKEN_MIRA";
const LEGACY_ENV_VAR = "JAZZ_TRIGGER_TOKEN_MIRA";

async function resolve(env: Record<string, string>): Promise<string | undefined> {
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  try {
    return await Effect.runPromise(resolveWebhookToken("mira"));
  } finally {
    for (const name of Object.keys(env)) delete process.env[name];
  }
}

describe("resolving a webhook's bearer token", () => {
  it("reads the current environment variable", async () => {
    expect(await resolve({ [NEW_ENV_VAR]: "from-new" })).toBe("from-new");
  });

  it("still reads the pre-rename environment variable", async () => {
    expect(await resolve({ [LEGACY_ENV_VAR]: "from-legacy" })).toBe("from-legacy");
  });

  it("prefers the current environment variable when both are set", async () => {
    expect(await resolve({ [NEW_ENV_VAR]: "from-new", [LEGACY_ENV_VAR]: "from-legacy" })).toBe(
      "from-new",
    );
  });

  it("ignores a blank value rather than authenticating callers with an empty token", async () => {
    expect(await resolve({ [NEW_ENV_VAR]: "   ", [LEGACY_ENV_VAR]: "from-legacy" })).toBe(
      "from-legacy",
    );
  });
});
