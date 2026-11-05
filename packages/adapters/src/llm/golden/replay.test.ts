import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { GoldenFixture } from "./fixture";
import {
  createGoldenReplay,
  describeRequestDrift,
  GoldenReplayDivergence,
} from "../../test-support/golden/replay";

const FIXTURE: GoldenFixture = {
  version: 1,
  scenario: "unit",
  provider: "openai",
  model: "gpt-4",
  calls: [
    {
      request: { messageRoles: ["system", "user"], toolNames: ["read_file"], toolResults: [] },
      parts: [
        { type: "text-delta", text: "hi" },
        { type: "finish", finishReason: "stop" },
      ],
    },
  ],
};

function ask(
  replay: ReturnType<typeof createGoldenReplay>,
  roles: readonly string[],
  toolNames: readonly string[],
) {
  return Effect.runPromiseExit(
    replay.service.createStreamingChatCompletion("openai", {
      model: "gpt-4",
      messages: roles.map((role) => ({ role, content: "" })),
      tools: toolNames.map((name) => ({ type: "function", function: { name, parameters: {} } })),
    } as never),
  );
}

describe("golden replay drift detection", () => {
  it("serves a matching request and reports the recorded response", async () => {
    const replay = createGoldenReplay(FIXTURE);
    const exit = await ask(replay, ["system", "user"], ["read_file"]);
    expect(exit._tag).toBe("Success");
    replay.assertExhausted();
    expect(replay.divergences).toEqual([]);
  });

  it("fails with a diff when a tool is offered that the recording did not have", async () => {
    const replay = createGoldenReplay(FIXTURE);
    const exit = await ask(replay, ["system", "user"], ["read_file", "delete_everything"]);
    expect(exit._tag).toBe("Failure");
    expect(replay.divergences).toHaveLength(1);
    expect(replay.divergences[0]).toContain(
      "+ tool offered now but absent from recording: delete_everything",
    );
  });

  it("fails with a diff when a recorded tool is no longer offered", async () => {
    const replay = createGoldenReplay(FIXTURE);
    await ask(replay, ["system", "user"], []);
    expect(replay.divergences[0]).toContain(
      "- tool offered in recording but missing now: read_file",
    );
  });

  it("fails when the message roles differ", async () => {
    const replay = createGoldenReplay(FIXTURE);
    await ask(replay, ["system", "user", "assistant", "tool"], ["read_file"]);
    expect(replay.divergences[0]).toContain("roles in recording: system user");
  });

  it("fails when the run asks for more calls than were recorded", async () => {
    const replay = createGoldenReplay(FIXTURE);
    await ask(replay, ["system", "user"], ["read_file"]);
    const exit = await ask(replay, ["system", "user"], ["read_file"]);
    expect(exit._tag).toBe("Failure");
    expect(replay.divergences[0]).toContain("model call #2 has no recording");
  });

  it("fails when the run makes fewer calls than were recorded", () => {
    const replay = createGoldenReplay(FIXTURE);
    expect(() => replay.assertExhausted()).toThrow(GoldenReplayDivergence);
  });

  it("describes nothing when the request matches", () => {
    expect(describeRequestDrift(0, FIXTURE.calls[0]!.request, FIXTURE.calls[0]!.request)).toBe("");
  });
});
