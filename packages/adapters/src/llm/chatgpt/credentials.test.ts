import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ChatGPTAccessTokenAuthenticationError,
  ChatGPTSignInRequiredError,
  createAccessTokenStore,
  createChatGPTCredentialStore,
  type CredentialStorage,
} from "./credentials";
import type { ChatGPTCredential } from "./oauth";

function credential(name: string, expiresInMs: number): ChatGPTCredential {
  return {
    access: `${name}-access`,
    refresh: `${name}-refresh`,
    expires: Date.now() + expiresInMs,
    accountId: `${name}-account`,
  };
}

const EXPIRED = -60_000;
const FRESH = 3_600_000;

function memoryStorage(initial?: ChatGPTCredential): CredentialStorage & {
  current: () => ChatGPTCredential | undefined;
  set: (value: ChatGPTCredential | undefined) => void;
} {
  let value = initial === undefined ? undefined : JSON.stringify(initial);
  return {
    read: () => Promise.resolve(value),
    write: (next) => {
      value = next;
      return Promise.resolve(true);
    },
    remove: () => {
      value = undefined;
      return Promise.resolve();
    },
    current: () => (value === undefined ? undefined : (JSON.parse(value) as ChatGPTCredential)),
    set: (next) => {
      value = next === undefined ? undefined : JSON.stringify(next);
    },
  };
}

/** A refresh call the test finishes by hand, to hold it in flight while something else happens. */
function heldRefresh(result: ChatGPTCredential): {
  readonly refresh: () => Promise<ChatGPTCredential>;
  readonly started: Promise<void>;
  readonly finish: () => void;
} {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    refresh: async () => {
      markStarted();
      await gate;
      return result;
    },
    started,
    finish: () => release(),
  };
}

const temporaryDirectories: string[] = [];

function lockPathInTemporaryDirectory(): () => string {
  const directory = mkdtempSync(path.join(tmpdir(), "jazz-chatgpt-lock-"));
  temporaryDirectories.push(directory);
  return () => path.join(directory, ".chatgpt-credential.lock");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ChatGPT credential store", () => {
  it("does not let a refresh in flight undo a sign-out", async () => {
    const storage = memoryStorage(credential("old", EXPIRED));
    const held = heldRefresh(credential("refreshed", FRESH));
    const store = createChatGPTCredentialStore({
      storage,
      refresh: held.refresh,
      lockPath: lockPathInTemporaryDirectory(),
    });

    const request = store.get();
    await held.started;
    const signOut = store.clear();
    held.finish();
    await request;
    await signOut;

    expect(storage.current()).toBeUndefined();
    await expect(store.get()).rejects.toBeInstanceOf(ChatGPTSignInRequiredError);
  });

  it("does not let a refresh in flight overwrite a new sign-in", async () => {
    const storage = memoryStorage(credential("first-account", EXPIRED));
    const held = heldRefresh(credential("first-account-refreshed", FRESH));
    const store = createChatGPTCredentialStore({
      storage,
      refresh: held.refresh,
      lockPath: lockPathInTemporaryDirectory(),
    });

    const request = store.get();
    await held.started;
    const secondAccount = credential("second-account", FRESH);
    const signIn = store.save(secondAccount);
    held.finish();
    await request;
    await signIn;

    expect(storage.current()).toEqual(secondAccount);
    expect(await store.get()).toEqual(secondAccount);
  });

  it("keeps a credential that replaced the one being refreshed", async () => {
    const storage = memoryStorage(credential("old", EXPIRED));
    const replacement = credential("replacement", FRESH);
    const store = createChatGPTCredentialStore({
      storage,
      refresh: () => {
        // Stands in for a writer that got the lock after it was reclaimed as stale.
        storage.set(replacement);
        return Promise.resolve(credential("refreshed", FRESH));
      },
      lockPath: lockPathInTemporaryDirectory(),
    });

    expect(await store.get()).toEqual(replacement);
    expect(storage.current()).toEqual(replacement);
  });

  it("shares one refresh between concurrent requests", async () => {
    const storage = memoryStorage(credential("old", EXPIRED));
    let refreshes = 0;
    const store = createChatGPTCredentialStore({
      storage,
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(credential("refreshed", FRESH));
      },
      lockPath: lockPathInTemporaryDirectory(),
    });

    const results = await Promise.all([store.get(), store.get(), store.get()]);

    expect(refreshes).toBe(1);
    expect(results.map((result) => result.access)).toEqual([
      "refreshed-access",
      "refreshed-access",
      "refreshed-access",
    ]);
  });
});

const HOUR_MS = 3_600_000;

describe("ChatGPT credential store validity margin", () => {
  it("refreshes a token that would expire within the requested validity", async () => {
    const storage = memoryStorage(credential("old", 2 * HOUR_MS));
    let refreshes = 0;
    const store = createChatGPTCredentialStore({
      storage,
      refresh: (refreshToken) => {
        refreshes += 1;
        expect(refreshToken).toBe("old-refresh");
        return Promise.resolve(credential("renewed", 240 * HOUR_MS));
      },
      lockPath: lockPathInTemporaryDirectory(),
    });

    const access = await store.get({ minValidityMs: 24 * HOUR_MS });

    expect(refreshes).toBe(1);
    expect(access.access).toBe("renewed-access");
    expect(storage.current()?.refresh).toBe("renewed-refresh");
  });

  it("keeps a token that outlasts the requested validity", async () => {
    const storage = memoryStorage(credential("current", 48 * HOUR_MS));
    const store = createChatGPTCredentialStore({
      storage,
      refresh: () => Promise.reject(new Error("must not refresh")),
      lockPath: lockPathInTemporaryDirectory(),
    });

    expect((await store.get({ minValidityMs: 24 * HOUR_MS })).access).toBe("current-access");
  });

  it("asks a memoized token for the requested validity too", async () => {
    const storage = memoryStorage(credential("current", 2 * HOUR_MS));
    let refreshes = 0;
    const store = createChatGPTCredentialStore({
      storage,
      refresh: () => {
        refreshes += 1;
        return Promise.resolve(credential("renewed", 240 * HOUR_MS));
      },
      lockPath: lockPathInTemporaryDirectory(),
    });

    expect((await store.get()).access).toBe("current-access");
    expect((await store.get({ minValidityMs: 24 * HOUR_MS })).access).toBe("renewed-access");
    expect(refreshes).toBe(1);
  });
});

function accessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const NOW = Date.parse("2026-11-11T12:00:00Z");

function chatGPTAccessToken(expiresAtMs: number): string {
  return accessToken({
    exp: expiresAtMs / 1000,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-1", chatgpt_plan_type: "pro" },
  });
}

describe("ChatGPT access-token store", () => {
  it("serves the token with the account, plan and expiry from its claims", async () => {
    const expires = NOW + 10 * HOUR_MS;
    const token = chatGPTAccessToken(expires);
    const store = createAccessTokenStore(token, () => NOW);

    expect(await store.get()).toEqual({
      access: token,
      expires,
      accountId: "account-1",
      plan: "pro",
    });
  });

  it("fails cleanly once the token has expired", async () => {
    const store = createAccessTokenStore(chatGPTAccessToken(NOW - 1_000), () => NOW);

    const failure = store.get();
    await expect(failure).rejects.toBeInstanceOf(ChatGPTAccessTokenAuthenticationError);
    await expect(failure).rejects.toThrow("expired at 2026-11-11T11:59:59.000Z");
  });

  it("refuses a token that would not last the requested validity", async () => {
    const store = createAccessTokenStore(chatGPTAccessToken(NOW + HOUR_MS), () => NOW);

    await expect(store.get({ minValidityMs: 2 * HOUR_MS })).rejects.toThrow(
      "sooner than the 120 minutes asked for",
    );
    expect((await store.get({ minValidityMs: 30 * 60_000 })).expires).toBe(NOW + HOUR_MS);
  });

  it("fails instead of refreshing when the server refuses the token", async () => {
    const token = chatGPTAccessToken(NOW + HOUR_MS);
    const store = createAccessTokenStore(token, () => NOW);

    await expect(store.get({ rejectedAccess: token })).rejects.toBeInstanceOf(
      ChatGPTAccessTokenAuthenticationError,
    );
  });

  it("names the failure an authentication error, so a model run does not retry it", () => {
    expect(new ChatGPTAccessTokenAuthenticationError("detail.").name).toMatch(
      /AuthenticationError$/,
    );
  });

  it("rejects a token without a ChatGPT account or an expiry", async () => {
    const withoutExpiry = accessToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    });
    const withoutAccount = accessToken({ exp: (NOW + HOUR_MS) / 1000 });

    for (const token of [withoutExpiry, withoutAccount, "not-a-jwt"]) {
      await expect(createAccessTokenStore(token, () => NOW).get()).rejects.toBeInstanceOf(
        ChatGPTAccessTokenAuthenticationError,
      );
    }
  });

  it("cannot sign in, sign out or read a stored sign-in", async () => {
    const store = createAccessTokenStore(chatGPTAccessToken(NOW + HOUR_MS), () => NOW);

    await expect(store.load()).rejects.toThrow("JAZZ_CHATGPT_ACCESS_TOKEN");
    await expect(store.save(credential("other", FRESH))).rejects.toThrow(
      "JAZZ_CHATGPT_ACCESS_TOKEN",
    );
    await expect(store.clear()).rejects.toThrow("JAZZ_CHATGPT_ACCESS_TOKEN");
  });
});

/**
 * The default store is chosen when the module loads, from the environment, so each case runs in a
 * fresh process that imports the module and reports what it saw.
 */
function loadDefaultStore(env: Record<string, string>): { readonly stdout: string } {
  const probe = `
    const credentials = await import(${JSON.stringify(path.join(import.meta.dir, "credentials.ts"))});
    const inherited = process.env.JAZZ_CHATGPT_ACCESS_TOKEN !== undefined;
    let outcome;
    try {
      outcome = { accountId: (await credentials.getChatGPTCredential()).accountId };
    } catch (error) {
      outcome = { error: error.message };
    }
    console.log(JSON.stringify({ inherited, ...outcome }));
  `;
  const jazzHome = mkdtempSync(path.join(tmpdir(), "jazz-chatgpt-home-"));
  temporaryDirectories.push(jazzHome);
  const result = Bun.spawnSync([process.execPath, "--eval", probe], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env["PATH"] ?? "",
      JAZZ_HOME: jazzHome,
      JAZZ_DISABLE_KEYRING: "1",
      ...env,
    },
  });
  return { stdout: result.stdout.toString().trim() };
}

describe("ChatGPT default store", () => {
  it("serves JAZZ_CHATGPT_ACCESS_TOKEN and removes it from the environment", () => {
    const token = chatGPTAccessToken(Date.now() + HOUR_MS);

    expect(JSON.parse(loadDefaultStore({ JAZZ_CHATGPT_ACCESS_TOKEN: token }).stdout)).toEqual({
      inherited: false,
      accountId: "account-1",
    });
  });

  it("refuses an access token and a full credential given together", () => {
    const token = chatGPTAccessToken(Date.now() + HOUR_MS);
    const bundle = JSON.stringify(credential("bundle", FRESH));

    const outcome = JSON.parse(
      loadDefaultStore({ JAZZ_CHATGPT_ACCESS_TOKEN: token, JAZZ_CHATGPT_CREDENTIAL: bundle })
        .stdout,
    ) as { readonly inherited: boolean; readonly error?: string };

    expect(outcome.inherited).toBe(false);
    expect(outcome.error).toContain("not both");
  });
});
