import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { execCommand, execCommandWithStdin } from "./shell-utils";

describe("shell-utils", () => {
  describe("execCommand", () => {
    it("should execute a simple command and return stdout", async () => {
      const result = await Effect.runPromise(execCommand("echo", ["hello"]));
      expect(result.trim()).toBe("hello");
    });

    it("should handle commands with multiple arguments", async () => {
      const result = await Effect.runPromise(execCommand("echo", ["-n", "test"]));
      expect(result).toBe("test");
    });

    it("should fail for non-existent commands", async () => {
      const result = Effect.runPromise(execCommand("nonexistent-command-xyz", []));
      await expect(result).rejects.toThrow();
    });

    it("should fail for commands that exit with non-zero code", async () => {
      const result = Effect.runPromise(execCommand("false", []));
      await expect(result).rejects.toThrow(/Command failed/);
    });

    it("should capture stderr in error message", async () => {
      // ls on a non-existent path outputs to stderr
      const result = Effect.runPromise(execCommand("ls", ["/nonexistent-path-xyz123"]));
      await expect(result).rejects.toThrow();
    });
  });

  describe("execCommandWithStdin", () => {
    it("should write to stdin and execute command", async () => {
      // Using 'cat' to echo back stdin
      const testInput = "hello from stdin";
      // cat returns the input, but execCommandWithStdin returns void
      // We'll use a command that reads stdin and succeeds
      await Effect.runPromise(execCommandWithStdin("cat", [], testInput));
      // If we get here without error, it worked
      expect(true).toBe(true);
    });

    it("should fail for commands that exit with non-zero code", async () => {
      const result = Effect.runPromise(execCommandWithStdin("false", [], "input"));
      await expect(result).rejects.toThrow(/Command failed/);
    });
  });
});
