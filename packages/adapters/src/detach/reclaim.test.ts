/** Round trip: hand a conversation to a "remote" Jazz home, change it there, and bring it back. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { commitDetach, prepareDetach } from "@jazz/core/agent/detach/ownership";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  applyDetachResult,
  createDetachSnapshot,
  importDetachSnapshot,
  withRemoteTurnsInUiTranscript,
} from "./snapshot";
import {
  loadConversation,
  saveConversation,
  type Conversation,
} from "../history/conversation-history-service";

let root: string;
let previousHome: string | undefined;
const ids = { agentId: "agent", conversationId: "conversation", handoffId: "handoff" };

function useHome(name: "local-home" | "remote-home"): void {
  process.env["JAZZ_HOME"] = path.join(root, name);
}

async function initRepository(workspaceRoot: string, files: Record<string, string>) {
  await fs.mkdir(workspaceRoot, { recursive: true });
  execFileSync("git", ["-C", workspaceRoot, "init", "-q"]);
  for (const [relative, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspaceRoot, relative), content);
  }
  execFileSync("git", ["-C", workspaceRoot, "add", "."]);
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
}

async function writeAgent(config: Record<string, unknown>): Promise<void> {
  const agents = path.join(process.env["JAZZ_HOME"]!, "agents");
  await fs.mkdir(agents, { recursive: true });
  await fs.writeFile(path.join(agents, "agent.json"), JSON.stringify({ id: "agent", config }));
}

function load() {
  return Effect.runPromise(
    loadConversation("agent", "conversation").pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

function save(conversation: Conversation) {
  return Effect.runPromise(
    saveConversation(conversation).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

/** Hand off, let the "remote" edit files and append a turn, then snapshot the remote result. */
async function handOffAndWorkRemotely(localEdit?: () => Promise<void>) {
  const workspaceRoot = path.join(root, "project");
  await initRepository(workspaceRoot, { "keep.txt": "keep", "edit.txt": "v1", "gone.txt": "bye" });
  useHome("local-home");
  await writeAgent({ persona: "default" });
  const initialDirectory = path.join(root, "initial");
  await createDetachSnapshot({
    ...ids,
    workspaceRoot,
    bundleDirectory: initialDirectory,
    history: [{ role: "user", content: "start" }],
  });

  useHome("remote-home");
  const remoteWorkspace = path.join(root, "remote-project");
  await importDetachSnapshot({ bundleDirectory: initialDirectory, workspaceRoot: remoteWorkspace });
  await fs.writeFile(path.join(remoteWorkspace, "edit.txt"), "v2");
  await fs.rm(path.join(remoteWorkspace, "gone.txt"));
  await fs.writeFile(path.join(remoteWorkspace, "new.txt"), "fresh");
  const remote = await load();
  await save({
    ...remote!,
    messages: [
      ...remote!.messages,
      { role: "user", content: "keep going" },
      { role: "assistant", content: "done remotely" },
    ],
  });
  const resultDirectory = path.join(root, "result");
  await createDetachSnapshot({
    ...ids,
    workspaceRoot: remoteWorkspace,
    bundleDirectory: resultDirectory,
  });

  useHome("local-home");
  await localEdit?.();
  return { workspaceRoot, initialDirectory, resultDirectory };
}

beforeEach(async () => {
  previousHome = process.env["JAZZ_HOME"];
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jazz-detach-reclaim-")));
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousHome;
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(path.join(os.tmpdir(), "jazz-todos-conversation.json"), { force: true });
});

describe("reclaiming a detached conversation", () => {
  test("applies remote file changes and the remote transcript locally", async () => {
    const { workspaceRoot, initialDirectory, resultDirectory } = await handOffAndWorkRemotely();

    const outcome = await applyDetachResult({
      initialDirectory,
      resultDirectory,
      overwriteConflicts: false,
    });

    expect(outcome).toEqual({
      applied: true,
      changedPaths: ["edit.txt", "gone.txt", "new.txt"],
      conflicts: [],
    });
    expect(await fs.readFile(path.join(workspaceRoot, "edit.txt"), "utf8")).toBe("v2");
    expect(await fs.readFile(path.join(workspaceRoot, "new.txt"), "utf8")).toBe("fresh");
    await expect(fs.stat(path.join(workspaceRoot, "gone.txt"))).rejects.toThrow();
    expect(await fs.readFile(path.join(workspaceRoot, "keep.txt"), "utf8")).toBe("keep");
    expect((await load())?.messages.map((message) => message.content)).toEqual([
      "start",
      "keep going",
      "done remotely",
    ]);
  });

  test("writes nothing while a file changed on both sides, unless remote may win", async () => {
    const { workspaceRoot, initialDirectory, resultDirectory } = await handOffAndWorkRemotely(
      async () => {
        await fs.writeFile(path.join(root, "project", "edit.txt"), "local edit");
      },
    );

    const blocked = await applyDetachResult({
      initialDirectory,
      resultDirectory,
      overwriteConflicts: false,
    });
    expect(blocked.applied).toBe(false);
    expect(blocked.conflicts).toEqual(["edit.txt"]);
    expect(await fs.readFile(path.join(workspaceRoot, "edit.txt"), "utf8")).toBe("local edit");
    expect(await fs.readFile(path.join(workspaceRoot, "gone.txt"), "utf8")).toBe("bye");
    expect((await load())?.messages).toHaveLength(1);

    const forced = await applyDetachResult({
      initialDirectory,
      resultDirectory,
      overwriteConflicts: true,
    });
    expect(forced.applied).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, "edit.txt"), "utf8")).toBe("v2");
  });

  test("imports the transcript through the fence its own handoff holds", async () => {
    const { initialDirectory, resultDirectory } = await handOffAndWorkRemotely();
    const fence = { ...ids, targetHost: "server" };
    await prepareDetach(fence);
    await commitDetach(fence);
    const current = await load();
    await expect(save(current!)).rejects.toThrow("remote");

    const outcome = await applyDetachResult({
      initialDirectory,
      resultDirectory,
      overwriteConflicts: false,
    });
    expect(outcome.applied).toBe(true);
    expect((await load())?.messages.at(-1)?.content).toBe("done remotely");
  });

  test("a retry after a partial apply does not call already-applied files conflicts", async () => {
    const { workspaceRoot, initialDirectory, resultDirectory } = await handOffAndWorkRemotely(
      async () => {
        await fs.writeFile(path.join(root, "project", "edit.txt"), "v2");
      },
    );
    const outcome = await applyDetachResult({
      initialDirectory,
      resultDirectory,
      overwriteConflicts: false,
    });
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.applied).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, "new.txt"), "utf8")).toBe("fresh");
  });

  test("the same agent and conversation can be handed to the same host again", async () => {
    const { workspaceRoot, initialDirectory, resultDirectory } = await handOffAndWorkRemotely();
    await applyDetachResult({ initialDirectory, resultDirectory, overwriteConflicts: false });
    await writeAgent({ persona: "default", llmModel: "changed-locally" });
    const secondBundle = path.join(root, "second");
    await createDetachSnapshot({
      ...ids,
      handoffId: "handoff-2",
      workspaceRoot,
      bundleDirectory: secondBundle,
    });

    useHome("remote-home");
    await importDetachSnapshot({
      bundleDirectory: secondBundle,
      workspaceRoot: path.join(root, "remote-project-2"),
    });
    const remoteAgent = await fs.readFile(
      path.join(root, "remote-home", "agents", "agent.json"),
      "utf8",
    );
    expect(remoteAgent).toContain("changed-locally");
  });

  test("refuses a result that belongs to another handoff", async () => {
    const { initialDirectory, resultDirectory } = await handOffAndWorkRemotely();
    const manifestPath = path.join(resultDirectory, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { handoffId: string };
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, handoffId: "other" }));

    await expect(
      applyDetachResult({ initialDirectory, resultDirectory, overwriteConflicts: false }),
    ).rejects.toThrow("identity");
  });
});

describe("user skills and custom personas travel with the handoff", () => {
  test("copies them to the host and accepts an identical copy already there", async () => {
    const workspaceRoot = path.join(root, "project");
    await initRepository(workspaceRoot, { "readme.md": "hi" });
    useHome("local-home");
    const home = process.env["JAZZ_HOME"]!;
    await fs.mkdir(path.join(home, "skills", "triage"), { recursive: true });
    await fs.writeFile(path.join(home, "skills", "triage", "SKILL.md"), "# triage");
    await fs.mkdir(path.join(home, "personas", "editor"), { recursive: true });
    await fs.writeFile(path.join(home, "personas", "editor", "PERSONA.md"), "# editor");
    await writeAgent({ persona: "editor", customTools: [{ name: "lint_all" }] });
    const bundleDirectory = path.join(root, "bundle");
    const manifest = await createDetachSnapshot({
      ...ids,
      workspaceRoot,
      bundleDirectory,
      history: [{ role: "user", content: "start" }],
    });
    expect(manifest.entries.map((entry) => entry.relativePath)).toEqual(
      expect.arrayContaining(["jazz/skills/triage/SKILL.md", "jazz/personas/editor/PERSONA.md"]),
    );

    useHome("remote-home");
    const remoteHome = process.env["JAZZ_HOME"]!;
    await fs.mkdir(path.join(remoteHome, "skills", "triage"), { recursive: true });
    await fs.writeFile(path.join(remoteHome, "skills", "triage", "SKILL.md"), "# triage");
    await importDetachSnapshot({
      bundleDirectory,
      workspaceRoot: path.join(root, "remote-project"),
    });
    expect(
      await fs.readFile(path.join(remoteHome, "personas", "editor", "PERSONA.md"), "utf8"),
    ).toBe("# editor");
  });

  test("refuses to overwrite a different skill of the same name on the host", async () => {
    const workspaceRoot = path.join(root, "project");
    await initRepository(workspaceRoot, { "readme.md": "hi" });
    useHome("local-home");
    const home = process.env["JAZZ_HOME"]!;
    await fs.mkdir(path.join(home, "skills", "triage"), { recursive: true });
    await fs.writeFile(path.join(home, "skills", "triage", "SKILL.md"), "# local triage");
    await writeAgent({ persona: "default" });
    const bundleDirectory = path.join(root, "bundle");
    await createDetachSnapshot({
      ...ids,
      workspaceRoot,
      bundleDirectory,
      history: [{ role: "user", content: "start" }],
    });

    useHome("remote-home");
    const remoteHome = process.env["JAZZ_HOME"]!;
    await fs.mkdir(path.join(remoteHome, "skills", "triage"), { recursive: true });
    await fs.writeFile(path.join(remoteHome, "skills", "triage", "SKILL.md"), "# remote triage");
    await expect(
      importDetachSnapshot({ bundleDirectory, workspaceRoot: path.join(root, "remote-project") }),
    ).rejects.toThrow("different skill");
  });

  test("names a persona it cannot find instead of sending the agent without it", async () => {
    const workspaceRoot = path.join(root, "project");
    await initRepository(workspaceRoot, { "readme.md": "hi" });
    useHome("local-home");
    await writeAgent({ persona: "plugin-acme-reviewer" });
    await expect(
      createDetachSnapshot({
        ...ids,
        workspaceRoot,
        bundleDirectory: path.join(root, "bundle"),
        history: [{ role: "user", content: "start" }],
      }),
    ).rejects.toThrow("plugin-acme-reviewer");
  });
});

describe("resumed transcript after reclaim", () => {
  const base: Conversation = {
    agentId: "agent",
    conversationId: "conversation",
    title: "",
    startedAt: "2026-09-26T00:00:00.000Z",
    endedAt: null,
    messages: [{ role: "user", content: "start" }],
    uiTranscript: [{ type: "user", message: "start" }],
  };

  test("appends the remote turns after the saved local transcript", () => {
    const returned: Conversation = {
      ...base,
      messages: [
        ...base.messages,
        { role: "user", content: "more" },
        { role: "tool", content: "ignored", tool_call_id: "call" },
        { role: "assistant", content: "answer" },
      ],
    };
    expect(withRemoteTurnsInUiTranscript(base, returned).uiTranscript).toEqual([
      { type: "user", message: "start" },
      { type: "info", message: "Continued on a remote host" },
      { type: "user", message: "more" },
      { type: "streamContent", message: "answer" },
    ]);
  });

  test("drops the stale transcript when the remote rewrote history", () => {
    const returned: Conversation = {
      ...base,
      messages: [{ role: "assistant", content: "compacted summary" }],
    };
    expect(withRemoteTurnsInUiTranscript(base, returned).uiTranscript).toBeUndefined();
  });
});
