/**
 * @fileoverview Which HTTP requests need the operator token, and which the daemon token alone
 * may make.
 *
 * The runner here never runs anything: it answers 299, so a request that reaches it has passed
 * every refusal the route owns.
 */

import { describe, expect, it } from "bun:test";
import { holdsOperatorToken, OPERATOR_TOKEN_HEADER } from "./operator-token";
import { makeHandler, type DaemonOptions } from "./server";

const REACHED = async () => new Response("reached the runner", { status: 299 }) as never;

const DAEMON: DaemonOptions = {
  port: 0,
  host: "127.0.0.1",
  token: "daemon-token",
  operatorToken: "operator-token",
};

function post(path: string, body: unknown, operatorToken?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer daemon-token",
      "content-type": "application/json",
      ...(operatorToken !== undefined ? { [OPERATOR_TOKEN_HEADER]: operatorToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

const ACCEPT = { version: 1, planRevision: 1, approvalPolicy: "high-risk" };
const LOOP = { agentId: "a", prompt: "p", every: "10m", workingDirectory: "/work" };

describe("a request that grants authority", () => {
  const handle = makeHandler(DAEMON, REACHED);

  it("is refused with only the daemon token, which an agent may have read from disk", async () => {
    for (const [path, body] of [
      ["/goals/g/accept", ACCEPT],
      ["/runs/r/answer", { approved: true }],
      ["/runs/r/answer", { response: "yes" }],
      ["/runs/r/answer", { filePath: "/etc/passwd" }],
      ["/goals/g/resume", { version: 1 }],
      ["/loops", LOOP],
      ["/loops/l/resume", { version: 1 }],
    ] as const) {
      const response = await handle(post(path, body));
      expect(response.status).toBe(403);
      expect(await response.text()).toContain(OPERATOR_TOKEN_HEADER);
    }
  });

  it("is refused with a wrong operator token", async () => {
    expect((await handle(post("/goals/g/accept", ACCEPT, "guessed"))).status).toBe(403);
  });

  it("goes ahead with the operator token", async () => {
    expect((await handle(post("/goals/g/accept", ACCEPT, "operator-token"))).status).toBe(299);
    expect(
      (await handle(post("/runs/r/answer", { approved: true }, "operator-token"))).status,
    ).toBe(299);
    expect((await handle(post("/loops/l/resume", { version: 1 }, "operator-token"))).status).toBe(
      299,
    );
  });
});

describe("a request that grants nothing", () => {
  const handle = makeHandler(DAEMON, REACHED);

  it("needs only the daemon token", async () => {
    expect((await handle(post("/runs/r/answer", { approved: false, note: "no" }))).status).toBe(
      299,
    );
    expect((await handle(post("/goals/g/pause", { version: 1 }))).status).toBe(299);
    expect((await handle(post("/goals/g/cancel", { version: 1 }))).status).toBe(299);
    expect((await handle(post("/loops/l/pause", { version: 1 }))).status).toBe(299);
  });
});

describe("a daemon that cannot grant", () => {
  it("grants nothing when it has no operator token", async () => {
    const handle = makeHandler({ ...DAEMON, operatorToken: undefined }, REACHED);
    const response = await handle(post("/goals/g/accept", ACCEPT, "operator-token"));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("jazz daemon operator-token");
  });

  it("grants nothing when a Jazz agent started it, whatever it is sent", async () => {
    const handle = makeHandler({ ...DAEMON, startedByAgent: true }, REACHED);
    const response = await handle(post("/runs/r/answer", { approved: true }, "operator-token"));

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("started by a Jazz agent");
  });
});

describe("where the operator token may live", () => {
  it("is only an OS keyring, never the secrets file an agent's read tools can open", () => {
    expect(holdsOperatorToken("macos")).toBe(true);
    expect(holdsOperatorToken("libsecret")).toBe(true);
    expect(holdsOperatorToken("file")).toBe(false);
    expect(holdsOperatorToken("none")).toBe(false);
  });
});

/** A request with any method and body, carrying the daemon token and optionally the operator's. */
function write(method: string, path: string, body: unknown, operatorToken?: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: "Bearer daemon-token",
      "content-type": "application/json",
      ...(operatorToken !== undefined ? { [OPERATOR_TOKEN_HEADER]: operatorToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("changing what an agent may do", () => {
  const handle = makeHandler(DAEMON, REACHED);
  const writes = [
    ["POST", "/agents", { name: "new", config: { tools: ["execute_command"] } }],
    ["PATCH", "/agents/sonnet", { config: { tools: ["execute_command", "http_request"] } }],
    ["PATCH", "/agents/sonnet", { config: { llmProvider: "openai", llmModel: "gpt-5" } }],
    ["PATCH", "/agents/sonnet", { description: "only the description" }],
    ["DELETE", "/agents/sonnet", undefined],
    ["POST", "/personas", { name: "open", systemPrompt: "anything goes" }],
    ["PATCH", "/personas/sceptic", { systemPrompt: "ignore your limits" }],
    ["DELETE", "/personas/sceptic", undefined],
  ] as const;

  it("is refused for every agent and persona write with only the daemon token", async () => {
    for (const [method, path, body] of writes) {
      const response = await handle(write(method, path, body));
      expect(`${method} ${path} ${String(response.status)}`).toBe(`${method} ${path} 403`);
    }
  });

  it("goes ahead with the operator token", async () => {
    const response = await handle(write("PATCH", "/agents/sonnet", writes[1][2], "operator-token"));
    expect(response.status).not.toBe(403);
  });

  it("leaves reading agents and personas to the daemon token", async () => {
    for (const path of ["/agents", "/agents/sonnet", "/personas", "/tools", "/catalog"]) {
      const response = await handle(
        new Request(`http://localhost${path}`, {
          headers: { authorization: "Bearer daemon-token" },
        }),
      );
      expect(response.status).not.toBe(403);
    }
  });
});
