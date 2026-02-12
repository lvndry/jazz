import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { execCommand, execCommandWithStdin, extractCommandApprovalKey } from "./shell-utils";

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

  describe("extractCommandApprovalKey", () => {
    it("should extract binary + subcommand for git commands", () => {
      expect(extractCommandApprovalKey("git diff --name-only")).toBe("git diff");
      expect(extractCommandApprovalKey("git diff --stat")).toBe("git diff");
      expect(extractCommandApprovalKey("git diff")).toBe("git diff");
      expect(extractCommandApprovalKey("git log --oneline -n 5")).toBe("git log");
      expect(extractCommandApprovalKey("git status")).toBe("git status");
      expect(extractCommandApprovalKey("git push --force origin main")).toBe("git push");
      expect(extractCommandApprovalKey("git commit -m 'hello world'")).toBe("git commit");
    });

    it("should return just the binary for commands with only flags", () => {
      expect(extractCommandApprovalKey("ls -la")).toBe("ls");
      expect(extractCommandApprovalKey("cat")).toBe("cat");
    });

    it("should include the first positional arg for non-subcommand tools", () => {
      // "rm /tmp/foo" is a better key than just "rm" — you wouldn't want
      // to auto-approve all rm invocations.
      expect(extractCommandApprovalKey("rm -rf /tmp/foo")).toBe("rm /tmp/foo");
    });

    it("should extract binary + subcommand for npm/yarn/pnpm commands", () => {
      expect(extractCommandApprovalKey("npm install --save-dev foo")).toBe("npm install");
      expect(extractCommandApprovalKey("npm test")).toBe("npm test");
      expect(extractCommandApprovalKey("yarn add react")).toBe("yarn add");
      expect(extractCommandApprovalKey("pnpm run build")).toBe("pnpm run");
    });

    it("should skip env-var prefixes", () => {
      expect(extractCommandApprovalKey("NODE_ENV=production npm test")).toBe("npm test");
      expect(extractCommandApprovalKey("FOO=bar BAZ=qux git status")).toBe("git status");
    });

    it("should skip wrapper commands like sudo, env, npx", () => {
      expect(extractCommandApprovalKey("sudo git status")).toBe("git status");
      expect(extractCommandApprovalKey("npx jest --coverage")).toBe("jest");
      expect(extractCommandApprovalKey("env git diff --stat")).toBe("git diff");
      expect(extractCommandApprovalKey("bunx vitest run")).toBe("vitest run");
    });

    it("should handle combined wrappers and env vars", () => {
      expect(extractCommandApprovalKey("NODE_ENV=test sudo npm test")).toBe("npm test");
    });

    it("should handle commands with only flags (no subcommand)", () => {
      expect(extractCommandApprovalKey("grep -rn pattern")).toBe("grep pattern");
    });

    it("should handle quoted arguments", () => {
      expect(extractCommandApprovalKey('git commit -m "some message"')).toBe("git commit");
      expect(extractCommandApprovalKey("git commit -m 'some message'")).toBe("git commit");
    });

    it("should handle empty and whitespace-only strings", () => {
      expect(extractCommandApprovalKey("")).toBe("");
      expect(extractCommandApprovalKey("   ")).toBe("");
    });

    it("should handle docker commands", () => {
      expect(extractCommandApprovalKey("docker build -t myimage .")).toBe("docker build");
      expect(extractCommandApprovalKey("docker compose up -d")).toBe("docker compose");
    });

    it("should handle kubectl commands", () => {
      expect(extractCommandApprovalKey("kubectl get pods -n default")).toBe("kubectl get");
      expect(extractCommandApprovalKey("kubectl apply -f config.yaml")).toBe("kubectl apply");
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
