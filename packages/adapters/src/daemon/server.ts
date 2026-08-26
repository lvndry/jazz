/**
 * @fileoverview A long-lived jazz that answers over HTTP.
 *
 * Not a second way to run an agent — the same one. A request lands here, resolves an agent,
 * and goes through `AgentRunner.run` exactly as `jazz run` does. What the daemon adds is
 * that the process outlives the request, which is what makes three things possible that a
 * process-per-invocation design cannot do at all:
 *
 * - a run that parks for a human can be answered by a different caller, hours later
 * - "what is this agent doing right now" is a question with an answer
 * - a bridge stops paying process startup on every message
 *
 * Most of the machinery is already here. {@link RunStore} gives durable records, park and
 * resume let a run outlive the process that started it, and `jazz runs` is the same set of
 * operations on a CLI. This is the socket in front of them.
 *
 * **It binds to loopback and refuses to leave it without a token.** Exposing an agent that
 * can read the filesystem to a network is a decision somebody should have to make twice.
 */

import { AgentRunner } from "@jazz/core/agent/agent-runner";
import { getAgentByIdentifier } from "@jazz/core/agent/agent-service";
import { isRunParkRequested } from "@jazz/core/agent/run/park-signal";
import { resumeRun } from "@jazz/core/agent/run/resume";
import type { AgentService } from "@jazz/core/interfaces/agent-service";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import type { ToolRegistry, ToolRequirements } from "@jazz/core/interfaces/tool-registry";
import type { PeerConfig } from "@jazz/core/types/peer";
import { generateConversationId } from "@jazz/core/utils/conversation-id";
import { Effect } from "effect";
import { servePeerRequest } from "@/adapters/peers/serve";

export const DEFAULT_DAEMON_PORT = 4747;

/**
 * What the daemon's handlers need from the runtime.
 *
 * Named rather than inferred so the caller knows exactly which layer to build — the same
 * stack `jazz run` composes, plus the run store, which is what makes a parked run
 * answerable by somebody who was not there when it parked.
 */
export type DaemonRequirements = AgentService | RunStoreTag | ToolRegistry | ToolRequirements;

/** Kept in step with `jazz runs`: terminal records are readable for a week. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DaemonOptions {
  readonly port: number;
  /**
   * Interface to bind. Loopback unless someone deliberately widens it.
   *
   * A daemon reachable from the network is an agent with filesystem access reachable from
   * the network, so widening this requires a token and is refused without one.
   */
  readonly host: string;
  /** Required for any bind that is not loopback. Compared with the `Authorization` header. */
  readonly token?: string | undefined;
  /**
   * Which agent answers peer questions, if any.
   *
   * Absent means `/peer/ask` is not served at all. Serving strangers is opt-in: a daemon
   * started to give its operator a local API should not quietly also be reachable by
   * anybody holding a peer token.
   */
  readonly peerAgent?: string | undefined;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Why a configuration is refused, or undefined when it is allowed.
 *
 * Returned rather than thrown so the caller can print it as advice. Every reason here is a
 * mistake someone would otherwise only discover from a log.
 */
export function refuseReason(options: DaemonOptions): string | undefined {
  if (!isLoopback(options.host) && (options.token === undefined || options.token.length === 0)) {
    return (
      `Refusing to bind ${options.host} without a token. A daemon on a network interface is ` +
      `an agent with filesystem access that anyone who can reach the port may drive. Set ` +
      `JAZZ_DAEMON_TOKEN, or bind 127.0.0.1.`
    );
  }
  return undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Constant-time-ish comparison for the bearer token.
 *
 * Not a rigorous constant-time compare — the lengths leak — but it does not return early on
 * the first differing byte, which is the difference that matters for a token guessable one
 * character at a time over a slow link.
 */
function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  }
  return difference === 0;
}

function authorized(request: Request, token: string | undefined): boolean {
  if (token === undefined || token.length === 0) return true;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return tokenMatches(token, presented);
}

interface StartRunBody {
  readonly agent?: unknown;
  readonly prompt?: unknown;
  readonly conversationId?: unknown;
}

/**
 * The daemon's request handler, as a plain function of a request.
 *
 * Separated from the socket so it can be driven directly in a test without binding a port,
 * and so the runtime that supplies the agent stack is provided once by the caller.
 */
export function makeHandler(
  options: DaemonOptions,
  runEffect: <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>) => Promise<A>,
): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health is unauthenticated on purpose: a supervisor should be able to see that the
    // process is alive without holding a credential that can drive an agent.
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (!authorized(request, options.token)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/runs") {
      let body: StartRunBody;
      try {
        body = (await request.json()) as StartRunBody;
      } catch {
        return json({ ok: false, error: "body must be JSON" }, 400);
      }
      const agentIdentifier = typeof body.agent === "string" ? body.agent : undefined;
      const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
      if (agentIdentifier === undefined || prompt === undefined) {
        return json({ ok: false, error: "agent and prompt are required" }, 400);
      }
      const conversationId =
        typeof body.conversationId === "string" && body.conversationId.length > 0
          ? body.conversationId
          : generateConversationId("daemon");

      return runEffect(startRun(agentIdentifier, prompt, conversationId));
    }

    const runMatch = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && runMatch?.[1] !== undefined) {
      return runEffect(describeRun(runMatch[1]));
    }

    const answerMatch = /^\/runs\/([^/]+)\/answer$/.exec(url.pathname);
    if (request.method === "POST" && answerMatch?.[1] !== undefined) {
      let body: { approved?: unknown; note?: unknown };
      try {
        body = (await request.json()) as { approved?: unknown; note?: unknown };
      } catch {
        return json({ ok: false, error: "body must be JSON" }, 400);
      }
      const approved = body.approved === true;
      const note = typeof body.note === "string" ? body.note : undefined;
      return runEffect(answerRun(answerMatch[1], approved, note));
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      return runEffect(listRuns());
    }

    return json({ ok: false, error: "not found" }, 404);
  };
}

/**
 * The peer-facing handler, separate from the operator's.
 *
 * A different door with a different credential. Everything on the operator's routes assumes
 * the caller is the person who owns this machine; a peer is somebody else's software, and
 * conflating the two would let one token do both jobs.
 */
export function makePeerHandler(
  options: DaemonOptions,
  peers: readonly PeerConfig[],
  resolveToken: (peerName: string) => Promise<string | undefined>,
  runEffect: <A>(effect: Effect.Effect<A, unknown, DaemonRequirements>) => Promise<A>,
): (request: Request) => Promise<Response> {
  return async function handlePeer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/peer/ask") {
      return json({ ok: false, error: "not found" }, 404);
    }
    if (options.peerAgent === undefined) {
      return json({ ok: false, error: "not accepting peer questions" }, 404);
    }

    const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (presented.length === 0) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    // Which peer is this? Resolved by matching the presented token against each configured
    // peer's own, so a token identifies its holder rather than merely admitting them.
    let caller: PeerConfig | undefined;
    for (const peer of peers) {
      const expected = await resolveToken(peer.name);
      if (expected !== undefined && expected.length > 0 && tokenMatches(expected, presented)) {
        caller = peer;
        break;
      }
    }
    if (caller === undefined) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    let body: { question?: unknown };
    try {
      body = (await request.json()) as { question?: unknown };
    } catch {
      return json({ ok: false, error: "body must be JSON" }, 400);
    }
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (question.length === 0) {
      return json({ ok: false, error: "question is required" }, 400);
    }

    return runEffect(answerPeer(caller, options.peerAgent, question));
  };
}

function answerPeer(peer: PeerConfig, agentIdentifier: string, question: string) {
  return Effect.gen(function* () {
    const agent = yield* getAgentByIdentifier(agentIdentifier);
    const outcome = yield* servePeerRequest({ peer, agent, question });

    switch (outcome.kind) {
      case "answered":
        return json({ ok: true, answer: outcome.answer });
      case "refused":
        return json({ ok: false, error: outcome.reason }, 403);
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed(
        json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500),
      ),
    ),
  );
}

function startRun(
  agentIdentifier: string,
  prompt: string,
  conversationId: string,
): Effect.Effect<Response, unknown, AgentService> {
  return Effect.gen(function* () {
    const agent = yield* getAgentByIdentifier(agentIdentifier);

    // Parking rather than declining is the whole reason a request can outlive its caller:
    // a gated tool stops the run and somebody answers it later, from anywhere.
    const response = yield* AgentRunner.run({
      agent,
      userInput: prompt,
      conversationId,
      parkWhenUnattended: true,
    });

    return json({ ok: true, answer: response.content, conversationId });
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        if (isRunParkRequested(error) && error.runId !== undefined) {
          const request =
            error.pending.kind === "tool-approval" ? error.pending.request : undefined;
          return json(
            {
              ok: false,
              state: "input-required",
              runId: error.runId,
              expiresAt: error.expiresAt,
              pending: {
                toolName: request?.toolName,
                message: request?.message,
              },
            },
            202,
          );
        }
        const logger = yield* Effect.serviceOption(LoggerServiceTag);
        if (logger._tag === "Some") {
          yield* logger.value.warn("Daemon run failed", { error: String(error) });
        }
        return json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }),
    ),
  ) as Effect.Effect<Response, unknown, AgentService>;
}

function describeRun(runId: string) {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    const record = yield* store.get(runId);
    if (record === undefined) return json({ ok: false, error: "no such run" }, 404);
    return json({ ok: true, run: record });
  });
}

function listRuns() {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    yield* store.prune({ now: new Date(), maxTerminalAgeMs: TERMINAL_RETENTION_MS });
    const runs = yield* store.list();
    return json({ ok: true, runs });
  });
}

/**
 * Answer a parked run and let it finish.
 *
 * The daemon resumes it rather than the caller doing so, because the daemon owns the store
 * and a claim carries the pid of whoever made it. A remote client claiming a run it cannot
 * be seen to abandon would leave it stranded in `working` if that client died.
 */
function answerRun(runId: string, approved: boolean, note: string | undefined) {
  return resumeRun({
    runId,
    outcome: approved
      ? { approved: true }
      : { approved: false, ...(note ? { userMessage: note } : {}) },
  }).pipe(
    Effect.map((response) => json({ ok: true, runId, answer: response.content })),
    Effect.catchAll((error) =>
      Effect.succeed(
        json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409),
      ),
    ),
  );
}
