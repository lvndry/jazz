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
    mockTerminal.ask.bind(mockTerminal),
    true,
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
        executeArgs: {},
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
        executeArgs: {},
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

describe("CLIPresentationService in a non-interactive session", () => {
  // `confirm` answers with its default rather than blocking when there is no
  // TTY, and the approval default is "yes" — so this must not ask at all.
  const nonInteractive = new CLIPresentationService(
    DEFAULT_DISPLAY_CONFIG,
    () => Effect.succeed(true),
    () => Effect.succeed(""),
    false,
  );

  it("declines approvals instead of taking the confirm default", async () => {
    const outcome = await Effect.runPromise(
      nonInteractive.requestApproval({
        toolName: "execute_command",
        message: "rm -rf /tmp/x",
        executeToolName: "execute_execute_command",
        executeArgs: { command: "rm -rf /tmp/x" },
      }),
    );

    expect(outcome.approved).toBe(false);
    expect(nonInteractive.canPromptForApproval()).toBe(false);
  });
});
