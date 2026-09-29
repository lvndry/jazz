/**
 * The guarded fetch against real sockets: a local Bun server stands in for loopback services,
 * cloud metadata and a second origin. Mirrors the audit repros for loopback reach
 * (`ssrf.ts`), cross-origin credential forwarding (`redir.ts`) and redirect-to-loopback through
 * `web_fetch` (`webfetch.ts`).
 */
import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { testConfigLayer } from "@/core/agent/test-config";
import { silentLogger } from "@/core/agent/test-logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import {
  EgressRefusedError,
  MAX_REDIRECT_HOPS,
  checkEgressDestination,
  guardedFetch,
  readBodyWithinBudget,
} from "./guarded-fetch";
import { createHttpRequestTool } from "./http";
import { createWebFetchTool } from "./web-fetch";

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly apiKey: string | null;
  readonly cookie: string | null;
  readonly body: string;
}

const ENDLESS_CHUNK_BYTES = 64 * 1024;
const TRICKLE_INTERVAL_MS = 200;

/** A body that never ends: each read waits for `next`. */
function streamOf(next: () => Promise<Uint8Array>): BodyInit {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      yield await next();
    }
  }
  return chunks() as unknown as BodyInit;
}

const hits: Hit[] = [];
let server: Server<undefined>;
let origin: string;
let secondServer: Server<undefined>;

function runHttp(
  args: Record<string, unknown>,
  context: ToolExecutionContext = { agentId: "agent" },
): Promise<ToolExecutionResult> {
  return Effect.runPromise(
    createHttpRequestTool()
      .execute(args, context)
      .pipe(Effect.provide(testConfigLayer())) as Effect.Effect<ToolExecutionResult>,
  );
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      hits.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        apiKey: request.headers.get("x-api-key"),
        cookie: request.headers.get("cookie"),
        body: await request.text(),
      });
      switch (url.pathname) {
        case "/redirect-same-origin":
          return Response.redirect(`${origin}/landing`, 302);
        case "/redirect-metadata":
          return Response.redirect("http://169.254.169.254/latest/meta-data/", 302);
        case "/redirect-localhost":
          return Response.redirect(`http://localhost:${String(server.port)}/landing`, 302);
        case "/redirect-second-origin":
          return Response.redirect(`http://localhost:${String(secondServer.port)}/`, 302);
        case "/redirect-307-second-origin":
          return Response.redirect(`http://localhost:${String(secondServer.port)}/`, 307);
        case "/see-other":
          return Response.redirect(`${origin}/landing`, 303);
        case "/loop":
          return Response.redirect(`${origin}/loop`, 302);
        case "/endless":
          return new Response(streamOf(async () => new Uint8Array(ENDLESS_CHUNK_BYTES)));
        case "/trickle":
          return new Response(
            streamOf(async () => {
              await Bun.sleep(TRICKLE_INTERVAL_MS);
              return new TextEncoder().encode("x");
            }),
          );
        default:
          return new Response(JSON.stringify({ secret: "loopback-only" }), {
            headers: { "content-type": "application/json" },
          });
      }
    },
  });
  origin = `http://127.0.0.1:${String(server.port)}`;
  secondServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      return new Response(
        JSON.stringify({
          method: request.method,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          cookie: request.headers.get("cookie"),
          accept: request.headers.get("accept"),
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
});

afterAll(() => {
  server.stop(true);
  secondServer.stop(true);
});

describe("HTTP request URL authorization", () => {
  it("refuses an unlisted URL before connecting", async () => {
    const before = hits.length;
    const result = await runHttp(
      { method: "GET", url: `${origin}/unlisted` },
      { agentId: "agent", httpApproval: [] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("network.httpApproval");
    expect(hits.length).toBe(before);
  });

  it("allows private GET and mutating requests by default without private-host grants", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const result = await runHttp({ method, url: `${origin}/default` }, { agentId: "agent" });
      expect(result.success).toBe(true);
      expect(hits.at(-1)?.method).toBe(method);
    }
  });

  it("applies query overrides before matching exact grants", async () => {
    const context = { agentId: "agent", httpApproval: [`${origin}/query?q=approved`] };
    const allowed = await runHttp(
      { method: "GET", url: `${origin}/query`, query: { q: "approved" } },
      context,
    );
    expect(allowed.success).toBe(true);
    const denied = await runHttp(
      { method: "GET", url: `${origin}/query?q=approved`, query: { q: "other" } },
      context,
    );
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("network.httpApproval");
  });

  it("limits a one-call grant to its exact URL and refuses an unlisted redirect", async () => {
    const result = await runHttp(
      { method: "GET", url: `${origin}/redirect-localhost` },
      {
        agentId: "agent",
        httpApproval: [],
        approvedHttpUrl: `${origin}/redirect-localhost`,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("network.httpApproval");
  });

  it("refuses mutating requests outside the URL list, credentials and all", async () => {
    const before = hits.length;
    const deleted = await runHttp(
      {
        method: "DELETE",
        url: `${origin}/runs/x`,
        headers: { Authorization: "Bearer stolen" },
      },
      { agentId: "agent", httpApproval: [] },
    );
    const posted = await runHttp(
      {
        method: "POST",
        url: `${origin}/runs`,
        body: { type: "json", value: { agent: "x", prompt: "p" } },
      },
      { agentId: "agent", httpApproval: [] },
    );
    expect(deleted.success).toBe(false);
    expect(posted.success).toBe(false);
    expect(hits.length).toBe(before);
  });

  it("labels an automatically authorized HTTP response as external content", async () => {
    const result = await runHttp({ method: "GET", url: `${origin}/ok` }, { agentId: "agent" });
    expect(result.success).toBe(true);
    expect(result.untrusted?.kind).toBe("external");
    const response = (result.result as { response: { status: number } }).response;
    expect(response.status).toBe(200);
  });

  it("refuses redirect URLs outside the configured grants", async () => {
    const result = await runHttp(
      { method: "GET", url: `${origin}/redirect-metadata` },
      { agentId: "agent", httpApproval: [`${origin}/*`] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("network.httpApproval");
  });

  it("does not treat different hostnames as the same grant", async () => {
    const result = await runHttp(
      { method: "GET", url: `${origin}/redirect-localhost` },
      { agentId: "agent", httpApproval: [`${origin}/*`] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("network.httpApproval");
  });

  it("follows a same-origin redirect with the caller's credentials intact", async () => {
    hits.length = 0;
    const result = await runHttp(
      {
        method: "GET",
        url: `${origin}/redirect-same-origin`,
        headers: { Authorization: "Bearer T" },
      },
      { agentId: "agent" },
    );
    expect(result.success).toBe(true);
    expect(hits.map((hit) => hit.path)).toEqual(["/redirect-same-origin", "/landing"]);
    expect(hits[1]?.authorization).toBe("Bearer T");
    expect((result.result as { response: { url?: string } }).response.url).toBe(
      `${origin}/landing`,
    );
  });

  it("turns a 303 after a POST into a body-less GET", async () => {
    hits.length = 0;
    const result = await runHttp(
      { method: "POST", url: `${origin}/see-other`, body: { type: "text", value: "payload" } },
      { agentId: "agent" },
    );
    expect(result.success).toBe(true);
    expect(hits[1]).toMatchObject({ method: "GET", path: "/landing", body: "" });
  });

  it(`stops after ${String(MAX_REDIRECT_HOPS)} redirects`, async () => {
    const result = await runHttp({ method: "GET", url: `${origin}/loop` }, { agentId: "agent" });
    expect(result.success).toBe(false);
    expect(result.error).toContain(`${String(MAX_REDIRECT_HOPS)} redirects`);
  });
});

describe("cross-origin redirects (audit repro redir.ts)", () => {
  const allowBoth = { agentId: "agent" };

  it("drops Authorization, Cookie and custom credential headers on a cross-origin hop", async () => {
    const result = await runHttp(
      {
        method: "GET",
        url: `${origin}/redirect-second-origin`,
        headers: {
          Authorization: "Bearer T",
          "X-Api-Key": "K",
          Cookie: "session=S",
          Accept: "application/json",
        },
      },
      allowBoth,
    );
    expect(result.success).toBe(true);
    const echoed = (result.result as { response: { body: { data: Record<string, unknown> } } })
      .response.body.data;
    expect(echoed).toMatchObject({
      authorization: null,
      apiKey: null,
      cookie: null,
      accept: "application/json",
    });
  });

  it("returns a cross-origin 307 that would resend the body instead of following it", async () => {
    const result = await runHttp(
      {
        method: "POST",
        url: `${origin}/redirect-307-second-origin`,
        body: { type: "text", value: "secret body" },
      },
      allowBoth,
    );
    expect(result.success).toBe(true);
    expect((result.result as { response: { status: number } }).response.status).toBe(307);
  });
});

describe("byte budgets and timers", () => {
  it("stops reading an endless body at maxResponseBytes", async () => {
    const maxResponseBytes = 100_000;
    const result = await runHttp(
      { method: "GET", url: `${origin}/endless`, maxResponseBytes },
      { agentId: "agent" },
    );
    expect(result.success).toBe(true);
    const response = (result.result as { response: { size: number; truncated: boolean } }).response;
    expect(response.size).toBe(maxResponseBytes);
    expect(response.truncated).toBe(true);
  });

  it("keeps the timeout running while the body is read", async () => {
    const started = Date.now();
    const result = await runHttp(
      { method: "GET", url: `${origin}/trickle`, timeoutMs: 600 },
      { agentId: "agent" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("readBodyWithinBudget returns the whole body when it fits", async () => {
    const read = await readBodyWithinBudget(new Response("hello"), 10);
    expect(new TextDecoder().decode(read.bytes)).toBe("hello");
    expect(read.truncated).toBe(false);
  });
});

describe("web_fetch (audit repro webfetch.ts)", () => {
  function runWebFetch(url: string, context: ToolExecutionContext = { agentId: "agent" }) {
    return Effect.runPromise(
      createWebFetchTool()
        .execute({ url }, context)
        .pipe(
          Effect.provideService(LoggerServiceTag, silentLogger),
          Effect.provide(testConfigLayer()),
        ) as Effect.Effect<ToolExecutionResult>,
    );
  }

  it("automatically fetches private destinations by default", async () => {
    const result = await runWebFetch(`${origin}/web-default`);
    expect(result.success).toBe(true);
    expect((result.result as { content: string }).content).toContain("loopback-only");
    expect(result.untrusted?.kind).toBe("external");
  });

  it("refuses a URL outside the web-fetch grant before connecting", async () => {
    const before = hits.length;
    const result = await runWebFetch(`${origin}/r`, { agentId: "agent", httpApproval: [] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("network.httpApproval");
    expect(hits.length).toBe(before);
  });

  it("refuses a redirect from an allowed host to metadata", async () => {
    const result = await runWebFetch(`${origin}/redirect-metadata`, {
      agentId: "agent",
      httpApproval: [`${origin}/*`],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("network.httpApproval");
  });
});

describe("checkEgressDestination", () => {
  it("resolves names through the injected resolver and refuses private answers", async () => {
    const rebinding = { resolveHost: async () => ["10.0.0.5"] };
    await expect(
      checkEgressDestination(new URL("https://attacker.example/"), rebinding),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it("refuses when any one of several answers is private", async () => {
    const mixed = { resolveHost: async () => ["93.184.215.14", "127.0.0.1"] };
    await expect(
      checkEgressDestination(new URL("https://mixed.example/"), mixed),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it("allows a public answer", async () => {
    const publicAnswer = { resolveHost: async () => ["93.184.215.14"] };
    await expect(
      checkEgressDestination(new URL("https://example.com/"), publicAnswer),
    ).resolves.toBeUndefined();
  });

  it("refuses URLs with embedded credentials and non-http schemes", async () => {
    const publicAnswer = { resolveHost: async () => ["93.184.215.14"] };
    await expect(
      checkEgressDestination(new URL("https://user:pass@example.com/"), publicAnswer),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    await expect(guardedFetch("file:///etc/passwd", publicAnswer)).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
  });
});
