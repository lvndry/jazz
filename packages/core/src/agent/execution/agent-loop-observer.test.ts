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

  it("maps onCostCapReached to presentWarning with spend and limit", async () => {
    const { service, calls } = recordingPresentation();
    await Effect.runPromise(makeDefaultObserver(service).onCostCapReached("Agent", 0.2, 0.2134));
    expect(calls[0]).toContain("cost cap reached ($0.2134 spent, limit $0.2000)");
  });

  it("maps onTokenCapReached to presentWarning with token count and limit", async () => {
    const { service, calls } = recordingPresentation();
    await Effect.runPromise(makeDefaultObserver(service).onTokenCapReached("Agent", 50000, 51234));
    expect(calls[0]).toContain("token cap reached (51,234 tokens, limit 50,000)");
  });

  it("maps onDurationCapReached to presentWarning with elapsed and budget minutes", async () => {
    const { service, calls } = recordingPresentation();
    await Effect.runPromise(
      makeDefaultObserver(service).onDurationCapReached("Agent", 30 * 60_000, 31 * 60_000),
    );
    expect(calls[0]).toContain("time budget reached (31 min elapsed, limit 30 min)");
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
