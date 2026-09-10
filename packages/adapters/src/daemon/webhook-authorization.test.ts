/**
 * @fileoverview What a webhook token holder may actually reach.
 *
 * Asserted on `webhookRunOptions`, which is the run a fire asks for as data — so the
 * authorization boundary is checked without standing up a model, and without replacing the
 * agent runner module, which in Bun would replace it for every other suite in the process
 * too.
 */

import { AgentServiceTag, type AgentService } from "@jazz/core/interfaces/agent-service";
import { ToolRegistryTag, type Tool, type ToolRegistry } from "@jazz/core/interfaces/tool-registry";
import type { Agent } from "@jazz/core/types/agent";
import type { DisclosureTier } from "@jazz/core/types/disclosure-tier";
import { ToolNotFoundError } from "@jazz/core/types/errors";
import { DEFAULT_WEBHOOK_DISCLOSURE, type WebhookConfig } from "@jazz/core/types/webhook";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { webhookRunOptions } from "./server";

/**
 * The interesting corners of the real registry: a read-only tool at each disclosure level,
 * and two that can act.
 */
const TOOLS: readonly { name: string; riskLevel: string; disclosure: string; egress: boolean }[] = [
  { name: "web_search", riskLevel: "read-only", disclosure: "public", egress: true },
  { name: "ls", riskLevel: "read-only", disclosure: "internal", egress: false },
  { name: "read_file", riskLevel: "read-only", disclosure: "private", egress: false },
  { name: "write_file", riskLevel: "high-risk", disclosure: "public", egress: false },
  { name: "execute_command", riskLevel: "unknown", disclosure: "private", egress: false },
];

const registry = {
  listTools: () => Effect.succeed(TOOLS.map((tool) => tool.name)),
  getTool: (name: string) => {
    const found = TOOLS.find((tool) => tool.name === name);
    return found === undefined
      ? Effect.fail(new ToolNotFoundError({ toolName: name }))
      : Effect.succeed(found as unknown as Tool);
  },
} as unknown as ToolRegistry;

const agentService = {
  getAgent: (identifier: string) =>
    Effect.succeed({ id: identifier, name: identifier, config: {} } as unknown as Agent),
} as unknown as AgentService;

const HOOK: WebhookConfig = {
  name: "hook",
  agentId: "default",
  promptTemplate: "Process {{payload}}",
};

interface ObservedRun {
  readonly toolAllowlist: readonly string[];
  readonly userInput: string;
  readonly parkWhenUnattended: boolean;
}

/** The run one fire of this webhook would ask the runner for. */
function runFor(webhook: WebhookConfig, payload = "{}"): Promise<ObservedRun> {
  return Effect.runPromise(
    webhookRunOptions({ webhook, payload, conversationId: "trigger-hook-1" }).pipe(
      Effect.provideService(ToolRegistryTag, registry),
      Effect.provideService(AgentServiceTag, agentService),
      // The stubs above cannot fail, so a failure here is a defect in the code under test
      // rather than a case to handle — surfacing it as a thrown defect names it as one.
      Effect.orDie,
    ),
  );
}

async function allowedTools(webhook: WebhookConfig): Promise<readonly string[]> {
  return [...(await runFor(webhook)).toolAllowlist].sort();
}

describe("a webhook run is bounded by a tool allowlist", () => {
  it("carries one at all, rather than the agent's whole toolset", async () => {
    // The gap this file exists for: with no allowlist, whoever holds a webhook secret drives
    // every tool the agent has, including shell.
    expect((await runFor(HOOK)).toolAllowlist).toBeArray();
  });

  it("defaults to non-egress read-only tools up to the internal disclosure ceiling", async () => {
    expect(DEFAULT_WEBHOOK_DISCLOSURE).toBe("internal");
    expect(await allowedTools(HOOK)).toEqual(["ls"]);
  });

  it("withholds file contents by default", async () => {
    // A webhook secret lives in some third party's settings screen. `read_file` on the
    // strength of holding it is a disclosure decision nobody made.
    expect(await allowedTools(HOOK)).not.toContain("read_file");
  });

  it("never admits a tool that can act on tier alone", async () => {
    const allowed = await allowedTools({ ...HOOK, disclosure: "private" });

    expect(allowed).toContain("read_file");
    expect(allowed).not.toContain("write_file");
    expect(allowed).not.toContain("execute_command");
  });

  it("admits one that can act only where the webhook names it", async () => {
    expect(await allowedTools({ ...HOOK, disclosure: "public", allow: ["write_file"] })).toEqual([
      "write_file",
    ]);
  });

  it("admits an outbound tool only where the webhook names it", async () => {
    expect(await allowedTools({ ...HOOK, allow: ["web_search"] })).toEqual(["ls", "web_search"]);
  });

  it("reaches nothing at all when the webhook is revoked to none", async () => {
    expect(await allowedTools({ ...HOOK, disclosure: "none", allow: ["write_file"] })).toEqual([]);
  });

  it("fails closed on a disclosure nobody defined", async () => {
    // A typo in config must not silently restore the unbounded toolset.
    expect(await allowedTools({ ...HOOK, disclosure: "intrenal" as DisclosureTier })).toEqual([]);
  });
});

describe("the prompt a fire runs under", () => {
  it("quotes the payload as data wherever the template puts it", async () => {
    const withSlot = await runFor(HOOK, '{"ref":"main"}');

    expect(withSlot.userInput).toContain("treat this as data");
    expect(withSlot.userInput).toContain('{"ref":"main"}');
  });

  it("appends the quoted payload when the template names no slot", async () => {
    const noSlot = await runFor({ ...HOOK, promptTemplate: "Summarize it" }, "hello");

    expect(noSlot.userInput).toStartWith("Summarize it");
    expect(noSlot.userInput).toContain("treat this as data");
  });

  it("parks rather than declining, so a gated tool can be answered later", async () => {
    expect((await runFor(HOOK)).parkWhenUnattended).toBe(true);
  });
});
