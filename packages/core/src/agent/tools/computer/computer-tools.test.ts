import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { createEgressTaint, taintedEgressNeedsApproval } from "@/core/agent/execution/egress-taint";
import { testConfigLayer } from "@/core/agent/test-config";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { type Tool, ToolRegistryTag } from "@/core/interfaces/tool-registry";
import { redactionPlaceholder } from "@/core/secrets/secret-names";
import {
  closeUserSecretStore,
  openUserSecretStore,
  type UserSecretStore,
} from "@/core/secrets/user-secrets";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import {
  createComputerAppsTool,
  createComputerEndTool,
  createComputerForegroundTools,
  createComputerHandoffTools,
  createComputerInputTools,
  createComputerObserveTool,
  createComputerPointerTools,
} from "./computer-tools";
import { requestStop } from "./control";
import { mailApp } from "./fake-driver";
import { ledgerPath } from "./ledger";
import { createToolRegistryLayer } from "../tool-registry";
import { ComputerSessions } from "./session";
import { useTemporaryJazzHome } from "./test-home";
import { startSession, type Started } from "./test-session";
import { COMPUTER_TOOL_NAMES } from "./tool-names";

useTemporaryJazzHome();

const pointer = createComputerPointerTools();
const input = createComputerInputTools();
const foreground = createComputerForegroundTools();
const handoff = createComputerHandoffTools();
const apps = createComputerAppsTool();
const observe = createComputerObserveTool();
const end = createComputerEndTool();

const stores: UserSecretStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    closeUserSecretStore(store);
  }
});

async function contextFor(started: Started, userSecrets?: UserSecretStore) {
  const sessions = new ComputerSessions();
  await sessions.obtain(async () => started.session);
  const context: ToolExecutionContext = {
    agentId: "agent-1",
    conversationId: "conversation-1",
    computerSessions: sessions,
    ...(userSecrets === undefined ? {} : { userSecrets }),
  };
  return { sessions, context };
}

function run(tool: Tool<never>, args: Record<string, unknown>, context: ToolExecutionContext) {
  return Effect.runPromise(
    (tool.execute(args, context) as Effect.Effect<ToolExecutionResult, never, never>).pipe(
      Effect.provide(testConfigLayer()),
    ),
  );
}

function asTool(tool: unknown): Tool<never> {
  return tool as Tool<never>;
}

function secretStore(name: string, value: string): UserSecretStore {
  const store = openUserSecretStore();
  store.hold(name, value);
  stores.push(store);
  return store;
}

describe("declarations", () => {
  const visible = [
    apps,
    observe,
    end,
    pointer.approval,
    input.approval,
    foreground.approval,
    handoff.approval,
  ].map(asTool);

  test("give each tool the risk tier that matches what it can do", () => {
    expect(Object.fromEntries(visible.map((tool) => [tool.name, tool.riskLevel]))).toEqual({
      computer_apps: "read-only",
      computer_observe: "read-only",
      computer_end: "read-only",
      computer_pointer: "low-risk",
      computer_input: "high-risk",
      computer_foreground: "high-risk",
      computer_handoff: "low-risk",
    });
  });

  test("mark the tools that act on the desktop as sending things out, and the readers as not", () => {
    expect(Object.fromEntries(visible.map((tool) => [tool.name, tool.egress]))).toEqual({
      computer_apps: false,
      computer_observe: false,
      computer_end: false,
      computer_pointer: true,
      computer_input: true,
      computer_foreground: true,
      computer_handoff: false,
    });
  });

  test("keep every computer tool out of a peer's disclosure tier", () => {
    expect(visible.every((tool) => tool.disclosure === "private")).toBe(true);
  });

  test("let a typed secret reach only the text of the tools that type", () => {
    for (const pair of [input, foreground]) {
      expect(pair.approval.userSecretArguments).toEqual(["text"]);
      expect(pair.execute.userSecretArguments).toEqual(["text"]);
    }
    expect(
      [apps, observe, end, pointer.approval, handoff.approval].every(
        (tool) => (tool as Tool<never>).userSecretArguments === undefined,
      ),
    ).toBe(true);
  });

  test("register exactly the names the attended-run gate removes", () => {
    const registered = [
      ...visible.map((tool) => tool.name),
      ...[pointer, input, foreground, handoff].map((pair) => pair.execute.name),
    ].sort();
    expect(registered).toEqual([...COMPUTER_TOOL_NAMES].sort());
    expect(
      [pointer, input, foreground, handoff].every((pair) => pair.execute.hidden === true),
    ).toBe(true);
  });

  test("give every visible tool a summary search_tools can match", () => {
    for (const tool of visible) {
      expect(tool.summary).toContain("experimental");
    }
  });
});

describe("reading", () => {
  test("lists the granted apps and their windows, as untrusted text", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));

    const result = await run(asTool(apps), {}, context);

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("Mail (com.apple.mail): full");
    expect(String(result.result)).toContain('window 1 "Inbox"');
    expect(result.untrusted).toEqual({ kind: "external", source: "computer_apps" });
  });

  test("observes a window: its id, its refs, and untrusted provenance naming the app", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));

    const result = await run(asTool(observe), {}, context);

    const text = String(result.result);
    expect(result.success).toBe(true);
    expect(text).toContain("observation: c1");
    expect(text).toContain('AXButton "Send" [ref=c1.0]');
    expect(result.untrusted).toEqual({ kind: "external", source: "computer_observe Mail" });
  });

  test("explains a missing grant instead of failing opaquely", async () => {
    const { context } = await contextFor(startSession([mailApp()], []));

    const result = await run(asTool(observe), {}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No apps are granted");
  });

  test("works only inside an agent run", async () => {
    const result = await run(asTool(observe), {}, { agentId: "agent-1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("only inside an agent run");
  });

  test("marks the run tainted, so a later low-risk action asks a person below the high-risk policy", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));
    const taint = createEgressTaint();
    const result = await run(asTool(observe), {}, context);
    if (result.untrusted?.kind === "external") {
      taint.mark(result.untrusted.source);
    }
    const gate = (policy: "low-risk" | "high-risk") =>
      taintedEgressNeedsApproval({
        toolName: "computer_pointer",
        args: { action: "click", ref: "c1.0" },
        egress: true,
        taint,
        policy,
        messages: [],
      });

    expect(gate("low-risk")).toBe(true);
    expect(gate("high-risk")).toBe(false);
  });
});

describe("pointer actions", () => {
  test("describe what will be clicked, in which app, for the person deciding", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));
    await run(asTool(observe), {}, context);

    const result = await run(asTool(pointer.approval), { action: "click", ref: "c1.0" }, context);

    const proposal = result.result as { approvalRequired: boolean; message: string };
    expect(proposal.approvalRequired).toBe(true);
    expect(proposal.message).toBe('Click AXButton "Send" in Mail');
  });

  test("answer a ref that matches nothing without asking", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));
    await run(asTool(observe), {}, context);

    const result = await run(asTool(pointer.approval), { action: "click", ref: "c1.99" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Nothing matches that ref");
  });

  test("answer with no window observed without asking", async () => {
    const result = await run(
      asTool(pointer.approval),
      { action: "click", ref: "c1.0" },
      { agentId: "agent-1", computerSessions: new ComputerSessions() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No window has been observed");
  });

  test("ask for the fields an action needs", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));

    const result = await run(asTool(pointer.approval), { action: "click_point", x: 1 }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("click_point needs observation");
  });

  test("click in the background and report what the driver confirmed", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const { context } = await contextFor(started);
    await run(asTool(observe), {}, context);

    const result = await run(asTool(pointer.execute), { action: "click", ref: "c1.0" }, context);

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("Mail: confirmed");
    expect(started.driver.actions[0]).toMatchObject({ kind: "click", delivery: "background" });
    expect(result.untrusted).toEqual({ kind: "external", source: "computer_pointer" });
  });

  test("tell the model to look again when the driver saw no change", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    started.driver.nextActionResult = {
      effect: "suspected_noop",
      summary: null,
      errorCode: null,
      hint: null,
    };
    const { context } = await contextFor(started);
    await run(asTool(observe), {}, context);

    const result = await run(asTool(pointer.execute), { action: "click", ref: "c1.0" }, context);

    expect(result.success).toBe(true);
    expect(String(result.result)).toContain("saw no change");
  });

  test("fail when the driver refuses", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    started.driver.nextActionResult = {
      effect: "refused",
      summary: null,
      errorCode: "blocked",
      hint: null,
    };
    const { context } = await contextFor(started);
    await run(asTool(observe), {}, context);

    const result = await run(asTool(pointer.execute), { action: "click", ref: "c1.0" }, context);

    expect(result.success).toBe(false);
  });
});

describe("typing", () => {
  test("describe what will be typed and where", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));
    await run(asTool(observe), {}, context);

    const result = await run(
      asTool(input.approval),
      { action: "type", ref: "c1.1", text: "Hello" },
      context,
    );

    const proposal = result.result as { message: string; alwaysAsk?: boolean };
    expect(proposal.message).toBe('Type "Hello" into AXTextField "Subject" in Mail');
    expect(proposal.alwaysAsk).toBeUndefined();
  });

  test("refuse to ask about typing into a password field without a collected secret", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));
    await run(asTool(observe), {}, context);

    const result = await run(
      asTool(input.approval),
      { action: "type", ref: "c1.2", text: "hunter2" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("password field");
  });

  test("always ask before entering a typed secret, and name only its placeholder", async () => {
    const secrets = secretStore("mail-password", "hunter2");
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]), secrets);
    await run(asTool(observe), {}, context);

    const result = await run(
      asTool(input.approval),
      { action: "type", ref: "c1.2", text: redactionPlaceholder("mail-password") },
      context,
    );

    const proposal = result.result as { alwaysAsk?: boolean; message: string };
    expect(proposal.alwaysAsk).toBe(true);
    expect(proposal.message).toContain(redactionPlaceholder("mail-password"));
    expect(proposal.message).toContain("into this app");
    expect(proposal.message).not.toContain("hunter2");
  });

  test("enter a collected secret into a password field without it reaching the result, the ledger or the observation", async () => {
    const secrets = secretStore("mail-password", "hunter2-typed");
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const { context } = await contextFor(started, secrets);
    const observed = await run(asTool(observe), {}, context);

    const result = await run(
      asTool(input.execute),
      { action: "type", ref: "c1.2", text: "hunter2-typed" },
      context,
    );

    expect(result.success).toBe(true);
    expect(started.driver.actions[0]).toMatchObject({ kind: "type", text: "hunter2-typed" });
    expect(JSON.stringify(result)).not.toContain("hunter2-typed");
    expect(JSON.stringify(observed)).not.toContain("hunter2");
    expect(readFileSync(ledgerPath(), "utf8")).not.toContain("hunter2-typed");
  });

  test("turn away a password field when what is typed is not a collected secret", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const { context } = await contextFor(started);
    await run(asTool(observe), {}, context);

    const result = await run(
      asTool(input.execute),
      { action: "type", ref: "c1.2", text: "guessed" },
      context,
    );

    expect(result.success).toBe(false);
    expect(started.driver.actions).toEqual([]);
  });

  test("press a shortcut in an observed window and refuse one that logs out", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const { context } = await contextFor(started);
    await run(asTool(observe), {}, context);

    const saved = await run(
      asTool(input.execute),
      { action: "key", observation: "c1", key: "s", modifiers: ["cmd"] },
      context,
    );
    const loggedOut = await run(
      asTool(input.execute),
      { action: "key", observation: "c1", key: "q", modifiers: ["cmd", "shift"] },
      context,
    );

    expect(saved.success).toBe(true);
    expect(loggedOut.success).toBe(false);
    expect(loggedOut.error).toContain("logs out");
  });
});

describe("bringing an app to the front", () => {
  test("says so in the approval, and needs the foreground grant to run", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const { context } = await contextFor(started);
    await run(asTool(observe), {}, context);

    const approval = await run(
      asTool(foreground.approval),
      { action: "click", ref: "c1.0" },
      context,
    );
    const executed = await run(
      asTool(foreground.execute),
      { action: "click", ref: "c1.0" },
      context,
    );

    expect((approval.result as { message: string }).message).toStartWith(
      "Bring the app to the front",
    );
    expect(executed.success).toBe(false);
    expect(executed.error).toContain("background use only");
  });

  test("runs once the app is granted for foreground use", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"], { foreground: true });
    const { context } = await contextFor(started);
    await run(asTool(observe), {}, context);

    const executed = await run(
      asTool(foreground.execute),
      { action: "click", ref: "c1.0" },
      context,
    );

    expect(executed.success).toBe(true);
    expect(started.driver.actions[0]).toMatchObject({ delivery: "foreground" });
  });
});

describe("handing a step to the person", () => {
  test("always asks, says what to do, and clears every observation once they are done", async () => {
    const { context } = await contextFor(startSession([mailApp()], ["com.apple.mail"]));
    await run(asTool(observe), {}, context);

    const approval = await run(asTool(handoff.approval), { reason: "Sign in to Mail" }, context);
    const proposal = approval.result as { alwaysAsk?: boolean; message: string };
    const done = await run(asTool(handoff.execute), { reason: "Sign in to Mail" }, context);
    const stale = await run(asTool(pointer.execute), { action: "click", ref: "c1.0" }, context);

    expect(proposal.alwaysAsk).toBe(true);
    expect(proposal.message).toContain("Sign in to Mail");
    expect(done.success).toBe(true);
    expect(stale.success).toBe(false);
    expect(stale.error).toContain("earlier look");
  });
});

describe("ending and stopping", () => {
  test("computer_end stops the driver and releases the desktop", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const { context, sessions } = await contextFor(started);

    const result = await run(asTool(end), {}, context);

    expect(result.success).toBe(true);
    expect(started.driver.closes).toBe(1);
    expect(started.lockReleases()).toBe(1);
    expect(sessions.peek()).toBeUndefined();
  });

  test("a stop request ends computer use for the rest of the run", async () => {
    const started = startSession([mailApp()], ["com.apple.mail"]);
    const { context, sessions } = await contextFor(started);
    await run(asTool(observe), {}, context);

    await requestStop();
    const result = await run(asTool(pointer.execute), { action: "click", ref: "c1.0" }, context);
    const after = await run(asTool(observe), {}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("You stopped computer use");
    expect(started.driver.actions).toEqual([]);
    expect(started.driver.closes).toBe(1);
    expect(after.success).toBe(false);
    expect(after.error).toContain("has ended");
    await expect(sessions.obtain(async () => started.session)).rejects.toThrow("has ended");
  });
});

describe("through the tool registry", () => {
  const quietLogger = {
    debug: () => Effect.void,
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
  } as unknown as LoggerService;
  const config = { appConfig: Effect.succeed({}) } as unknown as AgentConfigService;

  test("redacts a typed secret that a window happens to show", async () => {
    const secrets = secretStore("mail-password", "hunter2-typed");
    const started = startSession(
      [
        mailApp({
          windows: [
            {
              windowId: 1,
              title: "Inbox",
              elements: [{ role: "AXStaticText", label: "Your code is hunter2-typed" }],
            },
          ],
        }),
      ],
      ["com.apple.mail"],
    );
    const { context } = await contextFor(started, secrets);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistryTag;
        yield* registry.registerTool(asTool(observe));
        return yield* registry.executeTool("computer_observe", {}, context);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            createToolRegistryLayer(),
            Layer.succeed(LoggerServiceTag, quietLogger),
            Layer.succeed(AgentConfigServiceTag, config),
          ),
        ),
      ) as Effect.Effect<ToolExecutionResult, never, never>,
    );

    expect(result.success).toBe(true);
    expect(String(result.result)).not.toContain("hunter2-typed");
    expect(String(result.result)).toContain("[redacted:mail-password]");
  });
});
