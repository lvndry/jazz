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
 *
 * Minimal, but not approximate. Everything this door does emit is the shape a stock A2A
 * client parses: PascalCase JSON-RPC method names, a `SendMessageResponse` envelope around
 * the reply, and an agent card carrying the fields a client reads before it will talk at
 * all. A door that is A2A-shaped but not A2A-speaking is decorative, since interoperability
 * with clients nobody here wrote is the entire reason to have it.
 */

import { resolveAgentToolNames } from "@jazz/core/agent/tools/agent-tool-resolution";
import { ToolRegistryTag } from "@jazz/core/interfaces/tool-registry";
import type { ToolDisclosure } from "@jazz/core/interfaces/tool-registry";
import type { Agent } from "@jazz/core/types";
import type { PeerConfig } from "@jazz/core/types/peer";
import { Effect } from "effect";
import { allowedToolsForPeer, servePeerRequest } from "./serve";
import packageJson from "../../../../package.json";

/** The one security scheme this server actually accepts: a peer's own bearer token. */
const SECURITY_SCHEME_ID = "peer-token";

/**
 * The one protocol version this door speaks, as `Major.Minor`.
 *
 * A2A pins wire details to the version a caller asks for, so supporting several means
 * carrying several serializations of the same message. This door carries one. A caller
 * asking for anything else gets told so precisely, which is a better outcome than being
 * answered in a shape it cannot parse.
 */
const SUPPORTED_PROTOCOL_VERSION = "1.0";

/**
 * What a caller who sends no `A2A-Version` at all is taken to have said.
 *
 * Not this door's own version, and not a default to be widened to it. The protocol fixes the
 * meaning of a missing header rather than leaving each server to guess, precisely so that a
 * client too old to know the header exists cannot be mistaken for a current one. Reading
 * silence as the version we happen to speak would answer exactly that client in a shape it
 * cannot parse — the silent failure this door is built to avoid — so an unstated version is
 * refused the same as an unsupported one, and the refusal names what to send instead.
 */
const UNSTATED_VERSION_MEANS = "0.3";

/** The only content this door takes in or gives back: one question, one answer, as text. */
const TEXT_MODE = "text/plain";

/** JSON-RPC codes from A2A's own error range, distinct from the JSON-RPC 2.0 standard ones. */
const VERSION_NOT_SUPPORTED = -32009;

export interface AgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/** One endpoint a client can reach this agent on, and what it speaks there. */
export interface AgentInterface {
  readonly url: string;
  readonly protocolBinding: "JSONRPC";
  readonly protocolVersion: string;
}

export interface AgentCard {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly supportedInterfaces: readonly AgentInterface[];
  readonly capabilities: {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly extendedAgentCard: boolean;
  };
  readonly securitySchemes: Record<
    string,
    { readonly httpAuthSecurityScheme: { readonly scheme: string; readonly description: string } }
  >;
  readonly securityRequirements: readonly {
    readonly schemes: Record<string, { readonly list: readonly string[] }>;
  }[];
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly AgentSkill[];
}

/**
 * The unauthenticated card. Same for every caller, on purpose — this is the "what kind of
 * thing is this" advertisement, not a peer-specific capability list. See
 * `buildExtendedAgentCard` for the one that actually reflects a relationship.
 *
 * `endpointUrl` is where a client should send its JSON-RPC calls. The daemon derives it from
 * the address the card was fetched on rather than from configuration, so a card served
 * through a tunnel advertises the tunnel rather than a loopback address no peer can reach.
 */
export function buildPublicAgentCard(agentName: string, endpointUrl: string): AgentCard {
  return {
    name: agentName,
    description:
      "A jazz agent. Answers questions from established peers, within a disclosure tier " +
      "and tool grant its operator configured for each one. Fetch the extended card after " +
      "authenticating to see what a specific relationship can actually reach.",
    version: packageJson.version,
    supportedInterfaces: [
      {
        url: endpointUrl,
        protocolBinding: "JSONRPC",
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      },
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: true },
    securitySchemes: {
      [SECURITY_SCHEME_ID]: {
        httpAuthSecurityScheme: {
          scheme: "bearer",
          description:
            "The bearer token this agent's operator issued to one specific peer. It " +
            "identifies which relationship is calling, which is what selects the tier and " +
            "tool grant the answer is produced under.",
        },
      },
    },
    securityRequirements: [{ schemes: { [SECURITY_SCHEME_ID]: { list: [] } } }],
    defaultInputModes: [TEXT_MODE],
    defaultOutputModes: [TEXT_MODE],
    skills: [
      {
        id: "answer_question",
        name: "Answer a question",
        description:
          "Answers a plain-text question, subject to the caller's configured trust tier " +
          "and tool grant. Capability is fixed by the operator's own agent configuration, " +
          "the same for every peer — not negotiable per request, and not something a " +
          "relationship's tier or grant can ever widen.",
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
  endpointUrl: string,
  peer: PeerConfig,
  tools: readonly {
    readonly name: string;
    readonly riskLevel: string;
    readonly disclosure: ToolDisclosure;
  }[],
): AgentCard {
  const tier = peer.disclosure ?? "none";
  const allow = peer.allow ?? [];
  const reachable = allowedToolsForPeer(tier, allow, tools);
  const base = buildPublicAgentCard(agentName, endpointUrl);
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
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: readonly unknown[];
  };
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

/**
 * Reduces an `A2A-Version` header to the `Major.Minor` pair that decides compatibility. A
 * patch component carries no wire difference and is dropped rather than rejected, so a
 * caller announcing `1.0.3` is treated as the `1.0` caller it is.
 */
export function normalizeProtocolVersion(header: string | undefined | null): string {
  const trimmed = (header ?? "").trim();
  if (trimmed.length === 0) return UNSTATED_VERSION_MEANS;
  const parts = trimmed.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : trimmed;
}

function methodNotFound(id: string | number, method: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function invalidParams(id: string | number, detail: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code: -32602, message: `Invalid params: ${detail}` } };
}

function versionNotSupported(id: string | number, requested: string): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: VERSION_NOT_SUPPORTED,
      message:
        `A2A protocol version ${requested} is not supported. Send ` +
        `A2A-Version: ${SUPPORTED_PROTOCOL_VERSION}.`,
      data: [{ supportedVersions: [SUPPORTED_PROTOCOL_VERSION] }],
    },
  };
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

/**
 * Marks a reply as something other than a straight answer.
 *
 * A2A has one shape for "the agent said something" and no notion of an agent that declined,
 * so refusing and answering would otherwise arrive identically and a caller could log a
 * refusal as a reply. The distinction rides in message metadata, which the protocol leaves
 * free-form for exactly this, under a key namespaced to jazz so it cannot collide with a
 * field the protocol later defines.
 */
const OUTCOME_METADATA_KEY = "ai.jazz/outcome";

/** Wraps an agent's text in the `SendMessageResponse` envelope a client unwraps. */
export function buildMessageResult(
  id: string | number,
  text: string,
  outcome: "answered" | "refused" | "parked",
): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      message: {
        messageId: crypto.randomUUID(),
        role: "ROLE_AGENT",
        parts: [{ text }],
        ...(outcome === "answered" ? {} : { metadata: { [OUTCOME_METADATA_KEY]: outcome } }),
      },
    },
  };
}

/**
 * The JSON-RPC dispatch. Both methods this server understands go through the exact same
 * `servePeerRequest` `/peer/ask` already calls — this is a wire-format translation, not a
 * second implementation of the authorization decision.
 */
export function handleA2ARpc(
  agentName: string,
  endpointUrl: string,
  protocolVersion: string,
  peer: PeerConfig,
  agent: Agent,
  raw: unknown,
) {
  return Effect.gen(function* () {
    const request = parseA2ARequest(raw);
    if (request === undefined) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }

    if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      return versionNotSupported(request.id, protocolVersion);
    }

    if (request.method === "GetExtendedAgentCard") {
      // Scoped to what `agent` (the actual identity answering this peer) can really reach —
      // not the global registry, which lists every tool registered for every agent on this
      // machine. Advertising from the wrong source is how a card ends up promising a tool
      // this agent was never even given.
      const registry = yield* ToolRegistryTag;
      const allToolNames = yield* registry.listAllTools();
      // Same defensive filter `initializeAgentRun` applies: a custom tool an agent still
      // names in config can outlive its own MCP server or registration.
      const reachableNames = (yield* resolveAgentToolNames(agent)).filter((name) =>
        allToolNames.includes(name),
      );
      const described: { name: string; riskLevel: string; disclosure: ToolDisclosure }[] = [];
      for (const name of reachableNames) {
        const tool = yield* registry.getTool(name);
        described.push({ name, riskLevel: tool.riskLevel, disclosure: tool.disclosure });
      }
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: buildExtendedAgentCard(agentName, endpointUrl, peer, described),
      };
    }

    if (request.method === "SendMessage") {
      const question = extractQuestion(request.params);
      if (question === undefined) {
        return invalidParams(request.id, "params.message.parts must include non-empty text");
      }
      const outcome = yield* servePeerRequest({ peer, agent, question });
      // Every outcome comes back as a message rather than a JSON-RPC error, including the
      // ones that declined. A2A's error codes name protocol and task-lifecycle failures; an
      // agent that considered a question and would not answer it is neither, and reporting
      // it as one would tell a caller its request was malformed when it was understood
      // perfectly and turned down. What separates them on the wire is the outcome metadata.
      if (outcome.kind === "answered") {
        return buildMessageResult(request.id, outcome.answer, "answered");
      }
      // `parked` (the answering agent wants to ask something back before committing) has no
      // A2A task-lifecycle state to carry it — this door is deliberately staying that
      // minimal, see the file header. The clarifying question rides back as the message text,
      // tagged so a caller can tell it apart from a flat refusal.
      return outcome.kind === "parked"
        ? buildMessageResult(request.id, outcome.question, "parked")
        : buildMessageResult(request.id, outcome.reason, "refused");
    }

    return methodNotFound(request.id, request.method);
  });
}
