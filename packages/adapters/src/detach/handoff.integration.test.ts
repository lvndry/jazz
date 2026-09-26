/** An isolated handoff through two Jazz homes, with a queued continuation and return snapshot. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { test, expect } from "bun:test";
import { Effect } from "effect";
import { enqueueDetachedJob, readDetachedJob } from "./job";
import { createDetachSnapshot, importDetachSnapshot, verifyDetachSnapshot } from "./snapshot";
import { loadConversation } from "../history/conversation-history-service";

test("local handoff preserves Git state and conversation through a queued remote continuation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-handoff-integration-"));
  const previousHome = process.env["JAZZ_HOME"];
  const agentId = "agent-int";
  const conversationId = "conversation-int";
  const handoffId = "handoff-int";
  const todo = path.join(os.tmpdir(), `jazz-todos-${conversationId}.json`);
  try {
    const sourceWorkspace = path.join(root, "source-project");
    await fs.mkdir(sourceWorkspace);
    execFileSync("git", ["-C", sourceWorkspace, "init", "-q"]);
    await fs.writeFile(path.join(sourceWorkspace, "tracked.txt"), "before\n");
    await fs.writeFile(path.join(sourceWorkspace, "obsolete.txt"), "remove me\n");
    await fs.writeFile(path.join(sourceWorkspace, ".gitignore"), ".env\n");
    execFileSync("git", ["-C", sourceWorkspace, "add", "."]);
    execFileSync("git", [
      "-C",
      sourceWorkspace,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "starting point",
    ]);
    await fs.writeFile(path.join(sourceWorkspace, "tracked.txt"), "edited locally\n");
    await fs.rm(path.join(sourceWorkspace, "obsolete.txt"));
    await fs.writeFile(path.join(sourceWorkspace, "scratch.txt"), "unfinished work\n");
    await fs.writeFile(path.join(sourceWorkspace, ".env"), "API_KEY=private\n");
    const sourceStatus = execFileSync("git", ["-C", sourceWorkspace, "status", "--short"], {
      encoding: "utf8",
    });

    process.env["JAZZ_HOME"] = path.join(root, "source-jazz");
    const sourceWork = path.join(process.env["JAZZ_HOME"], "work", agentId, conversationId);
    await fs.mkdir(sourceWork, { recursive: true });
    await fs.writeFile(path.join(sourceWork, "state.json"), '{"nextStep":"finish the file"}\n');
    await fs.writeFile(todo, '[{"content":"finish the file","status":"in_progress"}]\n');
    const outbound = path.join(root, "outbound");
    const originalMessages = [{ role: "user" as const, content: "Finish the file tomorrow." }];
    await createDetachSnapshot({
      agentId,
      conversationId,
      handoffId,
      workspaceRoot: sourceWorkspace,
      bundleDirectory: outbound,
      history: originalMessages,
    });
    await verifyDetachSnapshot(outbound);

    await fs.rm(todo);
    process.env["JAZZ_HOME"] = path.join(root, "remote-jazz");
    const workspacePath = path.join(root, "remote-workspaces");
    const remoteWorkspace = path.join(workspacePath, handoffId);
    await importDetachSnapshot({ bundleDirectory: outbound, workspaceRoot: remoteWorkspace });
    expect(
      execFileSync("git", ["-C", remoteWorkspace, "status", "--short"], { encoding: "utf8" }),
    ).toBe(sourceStatus);
    expect(await fs.readFile(path.join(remoteWorkspace, "tracked.txt"), "utf8")).toBe(
      "edited locally\n",
    );
    expect(await fs.readFile(path.join(remoteWorkspace, "scratch.txt"), "utf8")).toBe(
      "unfinished work\n",
    );
    await expect(fs.stat(path.join(remoteWorkspace, ".env"))).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(root, "remote-jazz", "work", agentId, conversationId, "state.json"),
        "utf8",
      ),
    ).toContain("finish the file");
    expect(await fs.readFile(todo, "utf8")).toContain("in_progress");
    expect(
      (
        await Effect.runPromise(
          loadConversation(agentId, conversationId).pipe(Effect.provide(NodeFileSystem.layer)),
        )
      )?.messages,
    ).toEqual(originalMessages);

    const queued = await Effect.runPromise(
      enqueueDetachedJob({
        handoffId,
        agentId,
        conversationId,
        workspacePath,
        workspaceRoot: remoteWorkspace,
        continuation: "Continue from the saved work state.",
        approvalPolicy: "low-risk",
        maxCostUSD: 1,
        maxDurationMs: 60_000,
        maxIterations: 10,
      }),
    );
    expect(queued.status.kind).toBe("pending");
    expect((await Effect.runPromise(readDetachedJob(handoffId)))?.status.kind).toBe("pending");

    // The worker's completed turn is represented here by its persisted result and changed file.
    await fs.writeFile(path.join(remoteWorkspace, "scratch.txt"), "finished remotely\n");
    const completedMessages = [
      ...originalMessages,
      { role: "assistant" as const, content: "The file is finished." },
    ];
    const inbound = path.join(root, "inbound");
    await createDetachSnapshot({
      agentId,
      conversationId,
      handoffId: "return-int",
      workspaceRoot: remoteWorkspace,
      bundleDirectory: inbound,
      history: completedMessages,
    });
    await verifyDetachSnapshot(inbound);

    await fs.rm(todo);
    process.env["JAZZ_HOME"] = path.join(root, "return-jazz");
    const returnWorkspace = path.join(root, "return-project");
    await importDetachSnapshot({ bundleDirectory: inbound, workspaceRoot: returnWorkspace });
    expect(await fs.readFile(path.join(returnWorkspace, "scratch.txt"), "utf8")).toBe(
      "finished remotely\n",
    );
    expect(
      (
        await Effect.runPromise(
          loadConversation(agentId, conversationId).pipe(Effect.provide(NodeFileSystem.layer)),
        )
      )?.messages,
    ).toEqual(completedMessages);
  } finally {
    if (previousHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = previousHome;
    }
    await fs.rm(todo, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
