/**
 * @fileoverview A second door into the same room.
 *
 * `/peer/ask` is jazz's own protocol: a plain question in, a plain answer out. A2A
 * (Google's Agent2Agent protocol, now Linux Foundation-governed alongside MCP) is the
 * emerging standard for the same thing between agents that were never built to know about
 * each other. Its authorization model is deliberately unopinionated — a server must reject
 * an unauthorized caller, but the spec never says who counts as authorized — which is
 * exactly the gap jazz's tier/persona/`allow` model fills.
 *
 * So this is not a second trust system. Every request here is authenticated the same way
 * `/peer/ask` already is (a peer's own bearer token) and answered by the same
 * `servePeerRequest` — same ledger, same `toolAllowlist`, same persona resolution. What A2A
 * adds is a standards-shaped wire format and a capability-discovery document, nothing more.
 *
 * Deliberately minimal: one synchronous message method, one card-fetch method. No task
 * lifecycle, no streaming, no push notifications, no OAuth2/OIDC/mTLS — none of that has a
 * caller yet, and bolting it on speculatively is exactly the scope creep this feature nearly
 * shipped with the first time around.
 */

import { ToolRegistryTag } from "@jazz/core/interfaces/tool-registry";
import type { ToolDisclosure } from "@jazz/core/interfaces/tool-registry";
import type { Agent } from "@jazz/core/types";
import type { PeerConfig } from "@jazz/core/types/peer";
import { Effect } from "effect";
import { allowedToolsForPeer, servePeerRequest } from "./serve";

/** The one security scheme this server actually accepts: a peer's own bearer token. */
const SECURITY_SCHEME_ID = "peer-token";

export interface AgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface AgentCard {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly extendedAgentCard: boolean;
  };
  readonly securitySchemes: readonly {
    readonly id: string;
    readonly type: "http";
    readonly scheme: "bearer";
  }[];
  readonly security: readonly Record<string, readonly string[]>[];
  readonly skills: readonly AgentSkill[];
}

/**
 * The unauthenticated card. Same for every caller, on purpose — this is the "what kind of
 * thing is this" advertisement, not a peer-specific capability list. See
 * `buildExtendedAgentCard` for the one that actually reflects a relationship.
 */
export function buildPublicAgentCard(agentName: string): AgentCard {
  return {
    id: agentName,
    name: agentName,
    description:
      "A jazz agent. Answers questions from established peers, within a disclosure tier " +
      "and tool grant its operator configured for each one. Fetch the extended card after " +
      "authenticating to see what a specific relationship can actually reach.",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: true },
    securitySchemes: [{ id: SECURITY_SCHEME_ID, type: "http", scheme: "bearer" }],
    security: [{ [SECURITY_SCHEME_ID]: [] }],
    skills: [
      {
        id: "answer_question",
        name: "Answer a question",
        description:
          "Answers a plain-text question, subject to the caller's configured trust tier " +
          "and tool grant. Capability is fixed per relationship, not negotiable per request.",
        tags: ["read-only", "trust-scoped"],
      },
    ],
  };
}

/**
 * The authenticated card: skills reflect exactly what this peer's effective tool set is
 * right now, so a real caller can discover what they can reach instead of guessing from a
 * generic description.
 */
export function buildExtendedAgentCard(
  agentName: string,
  peer: PeerConfig,
  tools: readonly {
    readonly name: string;
    readonly riskLevel: string;
    readonly disclosure: ToolDisclosure;
  }[],
): AgentCard {
  const tier = peer.may ?? "none";
  const allow = peer.allow ?? [];
  const reachable = allowedToolsForPeer(tier, allow, tools);
  const base = buildPublicAgentCard(agentName);
  return {
    ...base,
    skills: [
      {
        id: "answer_question",
        name: "Answer a question",
        description: `Answers a plain-text question using: ${reachable.length > 0 ? reachable.join(", ") : "nothing — this peer is suspended"}.`,
        tags: reachable,
      },
    ],
  };
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result: unknown;
}

interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: { readonly code: number; readonly message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function parseA2ARequest(body: unknown): JsonRpcRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = body as Record<string, unknown>;
  if (
    candidate["jsonrpc"] === "2.0" &&
    (typeof candidate["id"] === "string" || typeof candidate["id"] === "number") &&
    typeof candidate["method"] === "string"
  ) {
    return {
      jsonrpc: "2.0",
      id: candidate["id"],
      method: candidate["method"],
      params: candidate["params"],
    };
  }
  return undefined;
}

function extractQuestion(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const message = (params as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return undefined;
  const parts = (message as Record<string, unknown>)["parts"];
  if (!Array.isArray(parts)) return undefined;
  const texts = parts
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as Record<string, unknown>)["text"] === "string"
        ? ((part as Record<string, unknown>)["text"] as string)
        : undefined,
    )
    .filter((text): text is string => text !== undefined);
  const question = texts.join("\n").trim();
  return question.length > 0 ? question : undefined;
}

function methodNotFound(id: string | number, method: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function invalidParams(id: string | number, detail: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code: -32602, message: `Invalid params: ${detail}` } };
}

/**
 * The JSON-RPC dispatch. Both methods this server understands go through the exact same
 * `servePeerRequest` `/peer/ask` already calls — this is a wire-format translation, not a
 * second implementation of the authorization decision.
 */
export function handleA2ARpc(agentName: string, peer: PeerConfig, agent: Agent, raw: unknown) {
  return Effect.gen(function* () {
    const request = parseA2ARequest(raw);
    if (request === undefined) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }

    if (request.method === "a2a.GetExtendedAgentCard") {
      const registry = yield* ToolRegistryTag;
      const names = yield* registry.listTools();
      const described: { name: string; riskLevel: string; disclosure: ToolDisclosure }[] = [];
      for (const name of names) {
        const tool = yield* registry.getTool(name);
        described.push({ name, riskLevel: tool.riskLevel, disclosure: tool.disclosure });
      }
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: buildExtendedAgentCard(agentName, peer, described),
      };
    }

    if (request.method === "a2a.SendMessage") {
      const question = extractQuestion(request.params);
      if (question === undefined) {
        return invalidParams(request.id, "params.message.parts must include non-empty text");
      }
      const outcome = yield* servePeerRequest({ peer, agent, question });
      if (outcome.kind === "answered") {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            messageId: `a2a-${Date.now().toString(36)}`,
            role: "ROLE_AGENT",
            parts: [{ text: outcome.answer }],
          },
        };
      }
      return { jsonrpc: "2.0", id: request.id, error: { code: -32001, message: outcome.reason } };
    }

    return methodNotFound(request.id, request.method);
  });
}
