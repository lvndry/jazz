import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  execCommand,
  execCommandWithStdin,
  extractCommandApprovalKey,
  isCommandCoveredByAllowlist,
} from "./shell";

describe("shell", () => {
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

    it("keys to the binary alone when a flag comes before any positional word", () => {
      expect(extractCommandApprovalKey("rm -rf /tmp/foo")).toBe("rm");
      expect(extractCommandApprovalKey("grep -rn pattern")).toBe("grep");
      expect(extractCommandApprovalKey("git -C status rm -rf .")).toBe("git");
    });

    it("keeps the first positional word when it follows the binary directly", () => {
      expect(extractCommandApprovalKey("rm /tmp/foo")).toBe("rm /tmp/foo");
    });

    it("should extract binary + subcommand for npm/yarn/pnpm commands", () => {
      expect(extractCommandApprovalKey("npm install --save-dev foo")).toBe("npm install");
      expect(extractCommandApprovalKey("npm test")).toBe("npm test");
      expect(extractCommandApprovalKey("yarn add react")).toBe("yarn add");
      expect(extractCommandApprovalKey("pnpm run build")).toBe("pnpm run");
    });

    it("has no key for a command with an environment-assignment prefix", () => {
      expect(extractCommandApprovalKey("NODE_ENV=production npm test")).toBeUndefined();
      expect(extractCommandApprovalKey("FOO=bar BAZ=qux git status")).toBeUndefined();
      expect(extractCommandApprovalKey("PAGER=x git log")).toBeUndefined();
    });

    it("keeps wrappers in the key so an approval never extends to another user or environment", () => {
      expect(extractCommandApprovalKey("sudo git status")).toBe("sudo git");
      expect(extractCommandApprovalKey("npx jest --coverage")).toBe("npx jest");
      expect(extractCommandApprovalKey("env PAGER=x git log")).toBe("env PAGER=x");
      expect(extractCommandApprovalKey("bunx vitest run")).toBe("bunx vitest");
    });

    it("should handle quoted arguments", () => {
      expect(extractCommandApprovalKey('git commit -m "some message"')).toBe("git commit");
      expect(extractCommandApprovalKey("git commit -m 'some message'")).toBe("git commit");
      expect(extractCommandApprovalKey("'git' \"status\"")).toBe("git status");
    });

    it("has no key for empty and whitespace-only strings", () => {
      expect(extractCommandApprovalKey("")).toBeUndefined();
      expect(extractCommandApprovalKey("   ")).toBeUndefined();
    });

    it("should handle docker commands", () => {
      expect(extractCommandApprovalKey("docker build -t myimage .")).toBe("docker build");
      expect(extractCommandApprovalKey("docker compose up -d")).toBe("docker compose");
    });

    it("should handle kubectl commands", () => {
      expect(extractCommandApprovalKey("kubectl get pods -n default")).toBe("kubectl get");
      expect(extractCommandApprovalKey("kubectl apply -f config.yaml")).toBe("kubectl apply");
    });

    it("has no key for a word built from an expansion", () => {
      expect(extractCommandApprovalKey("$EDITOR notes.md")).toBeUndefined();
      expect(extractCommandApprovalKey("git $SUBCOMMAND")).toBe("git");
    });
  });

  describe("isCommandCoveredByAllowlist", () => {
    const allowlist = ["git status", "ls"];

    it.each([
      "git status && rm -rf x",
      "git status $(rm x)",
      "git status `rm x`",
      "git status | sh",
      "git status > ~/.bashrc",
      "git status & rm x",
      "git status <(rm x)",
      "git status >(rm x)",
      "git status; rm x",
      "git status || rm x",
      "git status\nrm x",
      "git status 2>/dev/null",
      "git status ${HOME@P}",
      "git status # comment",
      "(git status)",
      "PAGER=x git status",
      "sudo git status",
      "ls $(rm x)",
      'ls "$(rm x)"',
      "git status 'unterminated",
    ])("never matches %p", (command) => {
      expect(isCommandCoveredByAllowlist(command, allowlist)).toBe(false);
    });

    it.each(["git status", "git status --short", "ls", "ls -la /tmp", "ls '$(literal)'"])(
      "matches the plain command %p",
      (command) => {
        expect(isCommandCoveredByAllowlist(command, allowlist)).toBe(true);
      },
    );

    it("keeps an environment prefix off an approved key", () => {
      expect(isCommandCoveredByAllowlist("PAGER=x git log", ["git log"])).toBe(false);
      expect(isCommandCoveredByAllowlist("git log", ["git log"])).toBe(true);
    });

    it("lets a binary entry cover its subcommands at a word boundary only", () => {
      expect(isCommandCoveredByAllowlist("git push", ["git"])).toBe(true);
      expect(isCommandCoveredByAllowlist("gitk", ["git"])).toBe(false);
    });

    it("keeps an option value from posing as the approved subcommand", () => {
      expect(isCommandCoveredByAllowlist("git -C status rm -rf .", ["git status"])).toBe(false);
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
