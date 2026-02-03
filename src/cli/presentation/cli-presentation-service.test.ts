import { describe, expect, it, mock } from "bun:test";
import { Effect, Layer } from "effect";
import { CLIPresentationService } from "./cli-presentation-service";
import { DEFAULT_DISPLAY_CONFIG } from "../../core/agent/types";
import { PresentationServiceTag } from "../../core/interfaces/presentation";
import { type TerminalService } from "../../core/interfaces/terminal";

// Mock dependencies
const mockTerminal = {
  confirm: mock((message: string, defaultValue?: boolean) => {
    console.log(`confirm called with: ${message}, default: ${defaultValue}`);
    return Effect.succeed(true);
  }),
  ask: mock(() => Effect.succeed("")),
} as unknown as TerminalService;

describe("CLIPresentationService", () => {
  const mockPresentationService = new CLIPresentationService(
    DEFAULT_DISPLAY_CONFIG,
    mockTerminal.confirm.bind(mockTerminal),
    mockTerminal.ask.bind(mockTerminal)
  );

  const testLayer = Layer.succeed(PresentationServiceTag, mockPresentationService);

  it("should request approval and return result", async () => {
    // Explicitly mock confirm to return true
    // @ts-expect-error - mocking
    mockTerminal.confirm.mockReturnValueOnce(Effect.succeed(true));

    const program = Effect.gen(function* () {
      const service = yield* PresentationServiceTag;
      return yield* service.requestApproval({
        toolName: "test-tool",
        message: "Danger!",
        executeToolName: "real-tool",
        executeArgs: {}
      });
    });

    // Mock stdout to avoid noise
    const originalWrite = process.stdout.write;

    process.stdout.write = mock(() => true) as any;

    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
      expect(result.approved).toBe(true);
      expect(mockTerminal.confirm).toHaveBeenCalled();
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("should handle rejection with optional message", async () => {
    // @ts-expect-error - mocking
    mockTerminal.confirm.mockReturnValueOnce(Effect.succeed(false));
    // @ts-expect-error - mocking
    mockTerminal.ask.mockReturnValueOnce(Effect.succeed("don't do it"));

    const program = Effect.gen(function* () {
      const service = yield* PresentationServiceTag;
      return yield* service.requestApproval({
        toolName: "test-tool",
        message: "Danger!",
        executeToolName: "real-tool",
        executeArgs: {}
      });
    });

    const originalWrite = process.stdout.write;

    process.stdout.write = mock(() => true) as any;

    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.userMessage).toBe("don't do it");
      }
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
