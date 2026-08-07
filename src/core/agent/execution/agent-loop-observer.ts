import { Effect } from "effect";
import type { PresentationService } from "@/core/interfaces/presentation";

/**
 * Lifecycle events the agent loop emits. Kept separate from PresentationService
 * so the loop is decoupled from the in-process presentation layer — a headless
 * server (PR 2) implements this to serialize lifecycle events over the wire.
 */
export interface AgentLoopObserver {
  onThinking(agentName: string, isFirstIteration: boolean): Effect.Effect<void, never, never>;
  onInterrupted(agentName: string): Effect.Effect<void, never, never>;
  onIterationLimit(agentName: string, maxIterations: number): Effect.Effect<void, never, never>;
  onEmptyResponse(agentName: string): Effect.Effect<void, never, never>;
  /** The agent runs on a local server whose real context window Jazz could not determine. */
  onContextWindowUnknown(agentName: string, advice: string): Effect.Effect<void, never, never>;
  onCompletion(agentName: string): Effect.Effect<void, never, never>;
}

/** Default observer: forwards loop lifecycle events to the PresentationService. */
export function makeDefaultObserver(presentation: PresentationService): AgentLoopObserver {
  return {
    onThinking: (agentName, isFirstIteration) =>
      presentation.presentThinking(agentName, isFirstIteration),
    onInterrupted: (agentName) =>
      presentation.presentWarning(agentName, "generation stopped by user"),
    onIterationLimit: (agentName, maxIterations) =>
      presentation.presentWarning(
        agentName,
        `iteration limit reached (${maxIterations}) - type 'continue' to resume`,
      ),
    onEmptyResponse: (agentName) =>
      presentation.presentWarning(agentName, "model returned an empty response"),
    onContextWindowUnknown: (agentName, advice) => presentation.presentWarning(agentName, advice),
    onCompletion: (agentName) => presentation.presentCompletion(agentName),
  };
}
