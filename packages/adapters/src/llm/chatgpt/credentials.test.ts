import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ChatGPTSignInRequiredError,
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
