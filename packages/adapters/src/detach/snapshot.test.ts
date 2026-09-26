import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createDetachSnapshot, importDetachSnapshot, verifyDetachSnapshot } from "./snapshot";
import { loadConversation } from "../history/conversation-history-service";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env["JAZZ_HOME"];
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-detach-snapshot-"));
  process.env["JAZZ_HOME"] = path.join(root, "local-home");
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousHome;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("portable detach snapshot", () => {
  const ids = { agentId: "agent", conversationId: "conversation", handoffId: "handoff" };

  test("restores exact history, workspace, work state and todos", async () => {
    const workspaceRoot = path.join(root, "project");
    await fs.mkdir(workspaceRoot);
    execFileSync("git", ["-C", workspaceRoot, "init", "-q"]);
    await fs.writeFile(path.join(workspaceRoot, "base.txt"), "base");
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), ".env\n");
    execFileSync("git", ["-C", workspaceRoot, "add", "base.txt", ".gitignore"]);
    execFileSync("git", [
      "-C",
      workspaceRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base",
    ]);
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "unfinished draft");
    await fs.writeFile(path.join(workspaceRoot, ".env"), "PRIVATE=do-not-transfer");
    const agentsDirectory = path.join(process.env["JAZZ_HOME"]!, "agents");
    await fs.mkdir(agentsDirectory, { recursive: true });
    await fs.writeFile(
      path.join(agentsDirectory, "agent.json"),
      JSON.stringify({
        id: "agent",
        config: { persona: "default", llmApiKeys: { openai: "secret-key" } },
      }),
    );
    const workDirectory = path.join(process.env["JAZZ_HOME"]!, "work", "agent", "conversation");
    await fs.mkdir(workDirectory, { recursive: true });
    await fs.writeFile(path.join(workDirectory, "state.json"), '{"nextStep":"continue"}');
    const todo = path.join(os.tmpdir(), "jazz-todos-conversation.json");
    await fs.writeFile(todo, '[{"content":"finish"}]');
    const bundleDirectory = path.join(root, "bundle");
    try {
      const manifest = await createDetachSnapshot({
        ...ids,
        workspaceRoot,
        bundleDirectory,
        history: [{ role: "user", content: "Write the draft" }],
      });
      expect(manifest.entries.some((entry) => entry.relativePath === "workspace/note.txt")).toBe(
        true,
      );
      expect(manifest.entries.some((entry) => entry.relativePath === "workspace/.env")).toBe(false);
      expect(await verifyDetachSnapshot(bundleDirectory)).toEqual(manifest);
      await fs.rm(todo);
      process.env["JAZZ_HOME"] = path.join(root, "remote-home");
      await importDetachSnapshot({
        bundleDirectory,
        workspaceRoot: path.join(root, "remote-project"),
      });
      const history = await Effect.runPromise(
        loadConversation("agent", "conversation").pipe(Effect.provide(NodeFileSystem.layer)),
      );
      expect(history?.messages).toEqual([{ role: "user", content: "Write the draft" }]);
      expect(
        await fs.readFile(path.join(root, "remote-home", "agents", "agent.json"), "utf8"),
      ).not.toContain("secret-key");
      expect(await fs.readFile(path.join(root, "remote-project", "note.txt"), "utf8")).toBe(
        "unfinished draft",
      );
      expect(
        execFileSync("git", ["-C", path.join(root, "remote-project"), "status", "--short"], {
          encoding: "utf8",
        }).trim(),
      ).toBe("?? note.txt");
      expect(
        await fs.readFile(
          path.join(root, "remote-home", "work", "agent", "conversation", "state.json"),
          "utf8",
        ),
      ).toContain("continue");
    } finally {
      await fs.rm(todo, { force: true });
    }
  });

  test("rejects a corrupt transferred file before writing a destination", async () => {
    const workspaceRoot = path.join(root, "project");
    await fs.mkdir(workspaceRoot);
    execFileSync("git", ["-C", workspaceRoot, "init", "-q"]);
    await fs.writeFile(path.join(workspaceRoot, "base.txt"), "base");
    execFileSync("git", ["-C", workspaceRoot, "add", "base.txt"]);
    execFileSync("git", [
      "-C",
      workspaceRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base",
    ]);
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "correct");
    const bundleDirectory = path.join(root, "bundle");
    await createDetachSnapshot({
      ...ids,
      workspaceRoot,
      bundleDirectory,
      history: [{ role: "user", content: "hello" }],
    });
    await fs.writeFile(path.join(bundleDirectory, "files", "workspace", "note.txt"), "wrong");
    process.env["JAZZ_HOME"] = path.join(root, "remote-home");
    await expect(verifyDetachSnapshot(bundleDirectory)).rejects.toThrow("verification failed");
    await expect(fs.stat(path.join(root, "remote-home"))).rejects.toThrow();
    await expect(
      importDetachSnapshot({ bundleDirectory, workspaceRoot: path.join(root, "remote-project") }),
    ).rejects.toThrow("verification failed");
    await expect(fs.stat(path.join(root, "remote-project"))).rejects.toThrow();

    await fs.writeFile(path.join(bundleDirectory, "files", "workspace", "note.txt"), "correct");
    const manifestPath = path.join(bundleDirectory, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      deletedPaths: string[];
      entries: unknown[];
    };
    manifest.deletedPaths = [".git/config"];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyDetachSnapshot(bundleDirectory)).rejects.toThrow("Git control");

    manifest.deletedPaths = [];
    manifest.entries.push({
      kind: "workspace",
      relativePath: "workspace/.git/config",
      size: 0,
      sha256: "0".repeat(64),
    });
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyDetachSnapshot(bundleDirectory)).rejects.toThrow("Git control");
  });

  test("refuses symlinks in the selected workspace", async () => {
    const workspaceRoot = path.join(root, "project");
    await fs.mkdir(workspaceRoot);
    execFileSync("git", ["-C", workspaceRoot, "init", "-q"]);
    await fs.writeFile(path.join(workspaceRoot, "base.txt"), "base");
    execFileSync("git", ["-C", workspaceRoot, "add", "base.txt"]);
    execFileSync("git", [
      "-C",
      workspaceRoot,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base",
    ]);
    await fs.symlink(path.join(root, "private"), path.join(workspaceRoot, "escape"));
    await expect(
      createDetachSnapshot({
        ...ids,
        workspaceRoot,
        bundleDirectory: path.join(root, "bundle"),
        history: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("symbolic link");
  });
});
