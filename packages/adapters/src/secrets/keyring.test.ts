import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { detectKeyringBackend, keyringGet, keyringSet, keyringDelete } from "./keyring";

const originalDisable = process.env["JAZZ_DISABLE_KEYRING"];

afterEach(() => {
  if (originalDisable === undefined) {
    delete process.env["JAZZ_DISABLE_KEYRING"];
  } else {
    process.env["JAZZ_DISABLE_KEYRING"] = originalDisable;
  }
});

describe("keyring opt-out", () => {
  it("reports no backend when JAZZ_DISABLE_KEYRING is set", async () => {
    process.env["JAZZ_DISABLE_KEYRING"] = "1";
    expect(await Effect.runPromise(detectKeyringBackend())).toBe("none");
  });

  it("treats explicit falsy values as not opting out", async () => {
    for (const value of ["0", "false", "", "  "]) {
      process.env["JAZZ_DISABLE_KEYRING"] = value;
      // Platform decides the result, but it must not short-circuit to "none"
      // for the opt-out reason on a platform Jazz supports.
      const backend = await Effect.runPromise(detectKeyringBackend());
      if (process.platform === "darwin") {
        expect(backend).toBe("macos");
      } else {
        expect(["libsecret", "none"]).toContain(backend);
      }
    }
  });
});

describe('the "none" backend', () => {
  it("reads nothing, refuses writes, and ignores deletes", async () => {
    expect(await Effect.runPromise(keyringGet("none", "llm.openai.api_key"))).toBeUndefined();
    expect(await Effect.runPromise(keyringSet("none", "llm.openai.api_key", "sk-x"))).toBe(false);
    await Effect.runPromise(keyringDelete("none", "llm.openai.api_key"));
  });
});
