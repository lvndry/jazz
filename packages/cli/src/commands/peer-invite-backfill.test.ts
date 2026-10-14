/**
 * `jazz peers invite accept` backfills `ask_peer` into every agent whose saved tools list
 * omits it. Before the Peers category became a default, an agent's tools were frozen at
 * creation time, so "added as a peer" quietly meant nothing: the tool was absent, and a
 * model without it answers peer questions from its own knowledge without anyone noticing.
 * This file pins the backfill contract: explicit lists get the tool appended, agents that
 * already have it — or that resolve tools by category default — are untouched, and a
 * machine with no agents is a clean no-op.
 */
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { createAgentServiceLayer } from "@jazz/adapters/agent-service";
import { createFileStorageLayer } from "@jazz/adapters/storage/file";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import type { AgentService } from "@jazz/core/interfaces/agent-service";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Effect, Layer } from "effect";
import { backfillAskPeerTool } from "./peer-invites";

describe("backfillAskPeerTool", () => {
  let jazzHome: string;
  let previousJazzHome: string | undefined;

  function agentLayer() {
    return createAgentServiceLayer().pipe(
      Layer.provide(createFileStorageLayer(jazzHome)),
      Layer.provide(NodeFileSystem.layer),
    );
  }

  function run(
    effect: Effect.Effect<readonly string[], never, AgentService>,
  ): Promise<readonly string[]> {
    return Effect.runPromise(effect.pipe(Effect.provide(agentLayer())));
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

    expect(updated).toEqual(["legacy"]);
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

    expect([...updated].sort()).toEqual(["one", "three"]);
  });

  it("returns nothing and touches no agent when every list already has the tool", async () => {
    await Effect.runPromise(
      seedAll([
        ["current", ["ls", "ask_peer"]],
        ["bare", undefined],
      ]),
    );

    const updated = await run(backfillAskPeerTool());

    expect(updated).toEqual([]);
    const state = await Effect.runPromise(describeAgents().pipe(Effect.provide(agentLayer())));
    expect(state).toEqual(expect.arrayContaining(["current:[ls,ask_peer]", "bare:[(default)]"]));
  });

  it("is a clean no-op on a machine with no agents yet", async () => {
    const updated = await run(backfillAskPeerTool());

    expect(updated).toEqual([]);
  });
});
