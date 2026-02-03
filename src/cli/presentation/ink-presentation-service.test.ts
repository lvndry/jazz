import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { InkStreamingRenderer } from "./ink-presentation-service";
import { store } from "../ui/App";
import type { LiveStreamState } from "../ui/types";

describe("InkStreamingRenderer", () => {
  const setStreamCalls: (LiveStreamState | null)[] = [];
  let originalSetStream: (typeof store)["setStream"];

  beforeEach(() => {
    setStreamCalls.length = 0;
    originalSetStream = store.setStream;
    store.setStream = (next: LiveStreamState | null) => {
      setStreamCalls.push(next);
      originalSetStream(next);
    };
  });

  afterEach(() => {
    store.setStream = originalSetStream;
  });

  describe("out-of-order text_chunk events", () => {
    test("ignores stale chunks and keeps text from highest sequence", async () => {
      const renderer = new InkStreamingRenderer(
        "TestAgent",
        false,
        {
          showThinking: true,
          showToolExecution: true,
          mode: "markdown",
          colorProfile: "full",
        },
      );

      Effect.runSync(renderer.handleEvent({
        type: "stream_start",
        provider: "test",
        model: "test",
        timestamp: Date.now(),
      }));
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Deliver text_chunk events out of order: seq 2, then 1, then 3
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "He",
        accumulated: "He",
        sequence: 2,
      }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "H",
        accumulated: "H",
        sequence: 1,
      }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "llo",
        accumulated: "Hello",
        sequence: 3,
      }));

      // Throttle is 50ms; wait for pending update to flush
      await new Promise((r) => setTimeout(r, 60));

      const withText = setStreamCalls.filter(
        (s): s is LiveStreamState => s !== null && s.text.length > 0,
      );
      expect(withText.length).toBeGreaterThan(0);
      expect(withText[withText.length - 1]!.text).toBe("Hello");
    });

    test("never overwrites with older sequence when chunks arrive out of order", async () => {
      const renderer = new InkStreamingRenderer(
        "TestAgent",
        false,
        {
          showThinking: true,
          showToolExecution: true,
          mode: "markdown",
          colorProfile: "full",
        },
      );

      Effect.runSync(renderer.handleEvent({
        type: "stream_start",
        provider: "test",
        model: "test",
        timestamp: Date.now(),
      }));
      Effect.runSync(renderer.handleEvent({ type: "text_start" }));

      // Newer first, then older (stale) – should keep "Hel", not revert to "H"
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "Hel",
        accumulated: "Hel",
        sequence: 2,
      }));
      Effect.runSync(renderer.handleEvent({
        type: "text_chunk",
        delta: "H",
        accumulated: "H",
        sequence: 1,
      }));

      await new Promise((r) => setTimeout(r, 60));

      const withText = setStreamCalls.filter(
        (s): s is LiveStreamState => s !== null && s.text.length > 0,
      );
      expect(withText.length).toBeGreaterThan(0);
      expect(withText[withText.length - 1]!.text).toBe("Hel");
    });
  });
});
