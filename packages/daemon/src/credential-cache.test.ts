import { describe, expect, it } from "bun:test";
import { cacheCredentialResolver } from "./credential-cache";

describe("caching door credentials", () => {
  it("reads each name once while the entry is fresh, even under concurrent lookups", async () => {
    const reads: string[] = [];
    const resolve = cacheCredentialResolver(async (name) => {
      reads.push(name);
      return `${name}-token`;
    }, 1000);

    const answers = await Promise.all([resolve("sam"), resolve("sam"), resolve("ada")]);
    await resolve("sam");

    expect(answers).toEqual(["sam-token", "sam-token", "ada-token"]);
    expect(reads).toEqual(["sam", "ada"]);
  });

  it("reads again once the entry expires, so a rotated token takes effect", async () => {
    let clock = 0;
    let token = "old";
    const resolve = cacheCredentialResolver(
      async () => token,
      1000,
      () => clock,
    );

    expect(await resolve("sam")).toBe("old");
    token = "new";
    clock = 999;
    expect(await resolve("sam")).toBe("old");
    clock = 1000;
    expect(await resolve("sam")).toBe("new");
  });

  it("does not remember a failed read", async () => {
    let attempts = 0;
    const resolve = cacheCredentialResolver(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("keyring timed out");
      }
      return "token";
    }, 1000);

    await expect(resolve("sam")).rejects.toThrow("keyring timed out");
    expect(await resolve("sam")).toBe("token");
  });
});
