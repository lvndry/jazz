import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  migrateAgentProviderName,
  migrateConfigProviderName,
  migrateKeyringProviderName,
} from "./provider-migration";

describe("migrateAgentProviderName", () => {
  it("renames the provider, the summarizer prefix, and the api key entry", () => {
    const { record, changed } = migrateAgentProviderName({
      id: "agent-1",
      config: {
        llmProvider: "google",
        llmModel: "gemini-2.5-pro",
        summarizerModel: "google/gemini-2.5-flash",
        llmApiKeys: { google: "AIza-key", openai: "sk-key" },
      },
    });

    expect(changed).toBe(true);
    const config = (record as { config: Record<string, unknown> }).config;
    expect(config["llmProvider"]).toBe("gemini");
    expect(config["summarizerModel"]).toBe("gemini/gemini-2.5-flash");
    expect(config["llmApiKeys"]).toEqual({ openai: "sk-key", gemini: "AIza-key" });
  });

  it("leaves an already-migrated agent untouched", () => {
    const input = { id: "a", config: { llmProvider: "gemini", llmModel: "gemini-2.5-pro" } };
    const { record, changed } = migrateAgentProviderName(input);
    expect(changed).toBe(false);
    expect(record).toBe(input);
  });

  it("does not touch other providers or a summarizer on another provider", () => {
    const { changed } = migrateAgentProviderName({
      config: { llmProvider: "openai", summarizerModel: "anthropic/claude-haiku-4-5" },
    });
    expect(changed).toBe(false);
  });

  it("does not rewrite a model id that merely contains google", () => {
    const { record, changed } = migrateAgentProviderName({
      config: { llmProvider: "openrouter", llmModel: "google/gemini-2.5-flash" },
    });
    expect(changed).toBe(false);
    expect((record as { config: Record<string, unknown> }).config["llmModel"]).toBe(
      "google/gemini-2.5-flash",
    );
  });

  it("keeps a key already stored under the new name", () => {
    const { record } = migrateAgentProviderName({
      config: { llmProvider: "google", llmApiKeys: { google: "old", gemini: "new" } },
    });
    expect((record as { config: Record<string, unknown> }).config["llmApiKeys"]).toEqual({
      gemini: "new",
    });
  });

  it("tolerates malformed records", () => {
    expect(migrateAgentProviderName(null).changed).toBe(false);
    expect(migrateAgentProviderName("nonsense").changed).toBe(false);
    expect(migrateAgentProviderName({ id: "no-config" }).changed).toBe(false);
  });
});

describe("migrateConfigProviderName", () => {
  it("moves llm.google to llm.gemini", () => {
    const record: Record<string, unknown> = {
      llm: { google: { api_key: "AIza" }, openai: { api_key: "sk" } },
    };
    expect(migrateConfigProviderName(record)).toBe(true);
    expect(record["llm"]).toEqual({ openai: { api_key: "sk" }, gemini: { api_key: "AIza" } });
  });

  it("keeps an existing llm.gemini entry", () => {
    const record: Record<string, unknown> = {
      llm: { google: { api_key: "old" }, gemini: { api_key: "new" } },
    };
    expect(migrateConfigProviderName(record)).toBe(true);
    expect(record["llm"]).toEqual({ gemini: { api_key: "new" } });
  });

  it("reports no change when there is nothing to migrate", () => {
    expect(migrateConfigProviderName({ llm: { openai: { api_key: "sk" } } })).toBe(false);
    expect(migrateConfigProviderName({})).toBe(false);
  });
});

describe("migrateKeyringProviderName", () => {
  function fakeKeyring(initial: Record<string, string>) {
    const store = { ...initial };
    return {
      store,
      get: (_backend: string, account: string) => Effect.succeed(store[account]),
      set: (_backend: string, account: string, secret: string) => {
        store[account] = secret;
        return Effect.succeed(true);
      },
      remove: (_backend: string, account: string) => {
        delete store[account];
        return Effect.void;
      },
    };
  }

  it("moves the entry to the new account name", async () => {
    const keyring = fakeKeyring({ "llm.google.api_key": "AIza" });
    const moved = await Effect.runPromise(
      migrateKeyringProviderName("macos", keyring.get, keyring.set, keyring.remove),
    );
    expect(moved).toBe(true);
    expect(keyring.store).toEqual({ "llm.gemini.api_key": "AIza" });
  });

  it("does not clobber a key already under the new name, but clears the old one", async () => {
    const keyring = fakeKeyring({ "llm.google.api_key": "old", "llm.gemini.api_key": "new" });
    await Effect.runPromise(
      migrateKeyringProviderName("macos", keyring.get, keyring.set, keyring.remove),
    );
    expect(keyring.store).toEqual({ "llm.gemini.api_key": "new" });
  });

  it("is a no-op when there is no legacy entry", async () => {
    const keyring = fakeKeyring({ "llm.openai.api_key": "sk" });
    const moved = await Effect.runPromise(
      migrateKeyringProviderName("macos", keyring.get, keyring.set, keyring.remove),
    );
    expect(moved).toBe(false);
    expect(keyring.store).toEqual({ "llm.openai.api_key": "sk" });
  });
});
