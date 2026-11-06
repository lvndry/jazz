import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createGoldenRecorder } from "./fixture";
import { goldenRecorderFromEnv, GOLDEN_RECORD_ENV, secretEnvValues } from "./record-env";

const CANARY_SECRET = "canary-secret-value-7f3a9c2e41";
const directories: string[] = [];

function scratchPath(): string {
  const directory = mkdtempSync(join(os.tmpdir(), "jazz-golden-fixture-"));
  directories.push(directory);
  return join(directory, "recorded.json");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("golden recorder", () => {
  it("writes a scrubbed fixture in which a canary secret never survives", () => {
    const path = scratchPath();
    const recorder = createGoldenRecorder({
      path,
      scenario: "canary",
      provider: "openai",
      model: "gpt-4",
      secrets: [CANARY_SECRET],
    });

    const call = recorder.beginCall({
      messageRoles: ["system", "user", "assistant", "tool"],
      toolNames: ["execute_command"],
      toolResults: [{ toolName: "execute_command", content: `token=${CANARY_SECRET}` }],
    });
    call.observePart({ type: "start-step", request: { body: `prompt with ${CANARY_SECRET}` } });
    call.observePart({ type: "text-delta", text: `your key is ${CANARY_SECRET}` });
    call.observePart({
      type: "tool-call",
      toolCallId: "call_AbCdEfGh12345678",
      toolName: "execute_command",
      input: { command: `echo ${CANARY_SECRET}`, apiKey: CANARY_SECRET },
    });
    call.observePart({
      type: "finish",
      finishReason: "stop",
      providerMetadata: { raw: CANARY_SECRET },
    });
    call.finish();

    const written = readFileSync(path, "utf8");
    expect(written).not.toContain(CANARY_SECRET);
    expect(written).not.toContain("AbCdEfGh");
    expect(written).not.toContain("prompt with");
    const parsed = JSON.parse(written) as { calls: { parts: { type: string }[] }[] };
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.parts.map((part) => part.type)).toEqual([
      "start-step",
      "text-delta",
      "tool-call",
      "finish",
    ]);
  });

  it("is inert unless JAZZ_GOLDEN_RECORD is set", () => {
    expect(goldenRecorderFromEnv("openai", "gpt-4", [], {})).toBeUndefined();
    expect(
      goldenRecorderFromEnv("openai", "gpt-4", [], { [GOLDEN_RECORD_ENV]: "" }),
    ).toBeUndefined();
  });

  it("collects secret-named environment values for scrubbing", () => {
    expect(
      secretEnvValues({
        OPENAI_API_KEY: CANARY_SECRET,
        GITHUB_TOKEN: "ghp-token-value",
        EMPTY_SECRET: "",
        PATH: "/usr/bin",
      }).sort(),
    ).toEqual(["ghp-token-value", CANARY_SECRET].sort());
  });
});
