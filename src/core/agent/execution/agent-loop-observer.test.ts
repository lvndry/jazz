import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { PresentationService } from "@/core/interfaces/presentation";
import { makeDefaultObserver } from "./agent-loop-observer";

function recordingPresentation() {
  const calls: string[] = [];
  const service = {
    presentThinking: (agentName: string, isFirst: boolean) =>
      Effect.sync(() => {
        calls.push(`thinking:${agentName}:${isFirst}`);
      }),
    presentWarning: (agentName: string, message: string) =>
      Effect.sync(() => {
        calls.push(`warning:${agentName}:${message}`);
      }),
    presentCompletion: (agentName: string) =>
      Effect.sync(() => {
        calls.push(`completion:${agentName}`);
      }),
  } as unknown as PresentationService;
  return { service, calls };
}

describe("makeDefaultObserver", () => {
  it("maps onThinking to presentThinking", async () => {
    const { service, calls } = recordingPresentation();
    await Effect.runPromise(makeDefaultObserver(service).onThinking("Agent", true));
    expect(calls).toEqual(["thinking:Agent:true"]);
  });

  it("maps onInterrupted, onIterationLimit and onEmptyResponse to presentWarning", async () => {
    const { service, calls } = recordingPresentation();
    const observer = makeDefaultObserver(service);
    await Effect.runPromise(observer.onInterrupted("Agent"));
    await Effect.runPromise(observer.onIterationLimit("Agent", 80));
    await Effect.runPromise(observer.onEmptyResponse("Agent"));
    expect(calls[0]).toBe("warning:Agent:generation stopped by user");
    expect(calls[1]).toContain("iteration limit reached (80)");
    expect(calls[2]).toBe("warning:Agent:model returned an empty response");
  });

  it("warns with the percentage and budget on context pressure", async () => {
    const { service, calls } = recordingPresentation();
    await Effect.runPromise(makeDefaultObserver(service).onContextPressure("Agent", 72, 128000));
    expect(calls[0]).toContain("context 72% full of 128,000 tokens");
  });

  it("maps onCompletion to presentCompletion", async () => {
    const { service, calls } = recordingPresentation();
    await Effect.runPromise(makeDefaultObserver(service).onCompletion("Agent"));
    expect(calls).toEqual(["completion:Agent"]);
  });
});
