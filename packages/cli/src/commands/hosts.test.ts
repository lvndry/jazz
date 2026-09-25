/** Failure-path tests for the internal remote secret import command. */
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { importRemoteSecretCommand } from "./hosts";

describe("remote secret import", () => {
  const previous = process.env["JAZZ_DISABLE_KEYRING"];

  afterEach(() => {
    if (previous === undefined) delete process.env["JAZZ_DISABLE_KEYRING"];
    else process.env["JAZZ_DISABLE_KEYRING"] = previous;
  });

  it("refuses disabled secret storage before consuming stdin", async () => {
    process.env["JAZZ_DISABLE_KEYRING"] = "1";
    await expect(
      Effect.runPromise(importRemoteSecretCommand("llm.openai.api_key")),
    ).rejects.toThrow("disabled");
  });

  it("refuses a token path outside selected provider credentials", async () => {
    await expect(Effect.runPromise(importRemoteSecretCommand("daemon.token"))).rejects.toThrow(
      "Only provider API keys",
    );
  });
});
