/**
 * Exercises invite tool backfill through the real agent service and file storage. Failure
 * injection happens at the storage boundary, so validation and persistence are still covered.
 * Run with `bun test packages/cli/src/commands/peer-invite-backfill.test.ts`.
 */
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { createAgentServiceLayer } from "@jazz/adapters/agent-service";
import { createConfigLayer } from "@jazz/adapters/config";
import { createFileStorageLayer } from "@jazz/adapters/storage/file";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import type { AgentService } from "@jazz/core/interfaces/agent-service";
import { StorageServiceTag, type StorageService } from "@jazz/core/interfaces/storage";
import { StorageError } from "@jazz/core/types/errors";
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { Effect, Layer } from "effect";
import { createPlainTerminalServiceLayer } from "../plain-terminal";
import {
  acceptInviteCommand,
  backfillAskPeerTool,
  type PeerToolBackfillResult,
} from "./peer-invites";

describe("backfillAskPeerTool", () => {
  let jazzHome: string;
  let previousJazzHome: string | undefined;

  interface StorageFailures {
    readonly writeNames?: readonly string[];
    readonly listing?: boolean;
  }

  function agentLayer(failures: StorageFailures = {}) {
    const storageLayer = Layer.effect(
      StorageServiceTag,
      Effect.map(StorageServiceTag, (storage): StorageService => ({
        saveAgent: (agent) =>
          failures.writeNames?.includes(agent.name)
            ? Effect.fail(
                new StorageError({ operation: "write", path: agent.id, reason: "disk full" }),
              )
            : storage.saveAgent(agent),
        listAgents: () =>
          failures.listing
            ? Effect.fail(
                new StorageError({
                  operation: "list",
                  path: jazzHome,
                  reason: "permission denied",
                }),
              )
            : storage.listAgents(),
        getAgent: (id) => storage.getAgent(id),
        inspectAgentFiles: () => storage.inspectAgentFiles(),
        deleteAgent: (id) => storage.deleteAgent(id),
      })),
    ).pipe(Layer.provide(createFileStorageLayer(jazzHome)));
    return createAgentServiceLayer().pipe(
      Layer.provide(storageLayer),
      Layer.provide(NodeFileSystem.layer),
    );
  }

  function run(
    effect: Effect.Effect<PeerToolBackfillResult, never, AgentService>,
    failures?: StorageFailures,
  ): Promise<PeerToolBackfillResult> {
    return Effect.runPromise(effect.pipe(Effect.provide(agentLayer(failures))));
  }

  function seed(name: string, tools?: readonly string[]) {
    return AgentServiceTag.pipe(
      Effect.flatMap((service) =>
        service.createAgent(name, `test agent ${name}`, tools ? { tools } : {}),
      ),
    );
  }

  function seedAll(entries: Array<[string, readonly string[] | undefined]>) {
    return Effect.all(entries.map(([name, tools]) => seed(name, tools))).pipe(
      Effect.provide(agentLayer()),
    );
  }

  function describeAgents(): Effect.Effect<readonly string[], unknown, AgentService> {
    return AgentServiceTag.pipe(
      Effect.flatMap((service) =>
        service
          .listAgents()
          .pipe(
            Effect.map((agents) =>
              agents.map(
                (agent) => `${agent.name}:[${agent.config.tools?.join(",") ?? "(default)"}]`,
              ),
            ),
          ),
      ),
    );
  }

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-peer-backfill-"));
    previousJazzHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousJazzHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousJazzHome;
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("appends ask_peer to agents with an explicit list that lacks it, and returns their names", async () => {
    await Effect.runPromise(
      seedAll([
        ["legacy", ["ls", "grep"]],
        ["fresh", ["ls", "ask_peer"]],
      ]),
    );

    const updated = await run(backfillAskPeerTool());

    expect(updated).toEqual({ updated: ["legacy"], errors: [] });
    const state = await Effect.runPromise(describeAgents().pipe(Effect.provide(agentLayer())));
    expect(state).toEqual(
      expect.arrayContaining(["legacy:[ls,grep,ask_peer]", "fresh:[ls,ask_peer]"]),
    );
  });

  it("updates every qualifying agent, not just the first", async () => {
    await Effect.runPromise(
      seedAll([
        ["one", ["read_file"]],
        ["two", ["ls", "ask_peer"]],
        ["three", ["execute_command"]],
      ]),
    );

    const updated = await run(backfillAskPeerTool());

    expect([...updated.updated].sort()).toEqual(["one", "three"]);
    expect(updated.errors).toEqual([]);
  });

  it("returns nothing and touches no agent when every list already has the tool", async () => {
    await Effect.runPromise(
      seedAll([
        ["current", ["ls", "ask_peer"]],
        ["bare", undefined],
      ]),
    );

    const updated = await run(backfillAskPeerTool());

    expect(updated).toEqual({ updated: [], errors: [] });
    const state = await Effect.runPromise(describeAgents().pipe(Effect.provide(agentLayer())));
    expect(state).toEqual(expect.arrayContaining(["current:[ls,ask_peer]", "bare:[(default)]"]));
  });

  it("is a clean no-op on a machine with no agents yet", async () => {
    const updated = await run(backfillAskPeerTool());

    expect(updated).toEqual({ updated: [], errors: [] });
  });

  it("reports only persisted updates and keeps updating other agents after a write fails", async () => {
    await Effect.runPromise(
      seedAll([
        ["broken", ["ls"]],
        ["healthy", ["grep"]],
      ]),
    );

    const result = await run(backfillAskPeerTool(), { writeNames: ["broken"] });

    expect(result.updated).toEqual(["healthy"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Could not update "broken"');
    expect(result.errors[0]).toContain("disk full");
    const state = await Effect.runPromise(describeAgents().pipe(Effect.provide(agentLayer())));
    expect(state).toEqual(expect.arrayContaining(["broken:[ls]", "healthy:[grep,ask_peer]"]));
  });

  it("reports a listing failure rather than treating storage as an empty installation", async () => {
    const result = await run(backfillAskPeerTool(), { listing: true });

    expect(result.updated).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Could not list agents");
    expect(result.errors[0]).toContain("permission denied");
  });

  it.each([false, true])(
    "reports partial acceptance without losing the saved peer (json=%s)",
    async (json) => {
      await Effect.runPromise(
        seedAll([
          ["broken", ["ls"]],
          ["healthy", ["grep"]],
        ]),
      );
      await nodeFs.writeFile(path.join(jazzHome, "config.json"), "{}");
      const previousPath = process.env["PATH"];
      const previousKeyring = process.env["JAZZ_DISABLE_KEYRING"];
      const previousExitCode = process.exitCode;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const out = spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      let accepts = 0;
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          if (request.method === "POST") {
            accepts += 1;
            return Response.json({ ok: true, token: "test-only-shared-peer-token" });
          }
          return Response.json({
            inviterDisplayName: "bob",
            inviterAskUrl: "http://127.0.0.1:4747/peer/ask",
            proposedTier: "internal",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            status: "active",
          });
        },
      });
      try {
        process.env["PATH"] = jazzHome;
        process.env["JAZZ_DISABLE_KEYRING"] = "0";
        const configLayer = createConfigLayer(false, path.join(jazzHome, "config.json")).pipe(
          Layer.provide(NodeFileSystem.layer),
        );
        await Effect.runPromise(
          acceptInviteCommand({
            url: `http://127.0.0.1:${server.port}/peer-invites/test#secret`,
            yes: true,
            json,
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                agentLayer({ writeNames: ["broken"] }),
                configLayer,
                createPlainTerminalServiceLayer(),
              ),
            ),
          ),
        );
        expect(process.exitCode).toBe(1);
        expect(accepts).toBe(1);
        expect(await nodeFs.readFile(path.join(jazzHome, "secrets.json"), "utf8")).toContain(
          "test-only-shared-peer-token",
        );
        const config: unknown = JSON.parse(
          await nodeFs.readFile(path.join(jazzHome, "config.json"), "utf8"),
        );
        expect(config).toMatchObject({
          peers: [{ name: "bob", url: "http://127.0.0.1:4747/peer/ask" }],
        });
        if (json) {
          const envelope: unknown = JSON.parse(stdout.join(""));
          expect(envelope).toMatchObject({
            ok: false,
            name: "bob",
            backfilled: ["healthy"],
            backfillErrors: [expect.stringContaining('Could not update "broken"')],
          });
          expect(stderr.join("")).toBe("");
        } else {
          expect(stdout.join("")).toContain("Added ask_peer to agent tools: healthy");
          expect(stdout.join("")).not.toContain("Added ask_peer to agent tools: broken");
          expect(stderr.join("")).toContain("peer and token were saved");
          expect(stderr.join("")).toContain("do not accept it again");
        }
      } finally {
        out.mockRestore();
        err.mockRestore();
        server.stop(true);
        if (previousPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previousPath;
        if (previousKeyring === undefined) delete process.env["JAZZ_DISABLE_KEYRING"];
        else process.env["JAZZ_DISABLE_KEYRING"] = previousKeyring;
        process.exitCode = previousExitCode ?? 0;
      }
    },
  );
});
