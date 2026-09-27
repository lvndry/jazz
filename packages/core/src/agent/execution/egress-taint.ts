/**
 * Egress after untrusted input: the run-scoped rule that stops a read-only agent from being
 * talked into sending data out.
 *
 * An inbox digest running at `autoApprove: read-only` may read attacker-written mail, and
 * `web_fetch`/`http_request`/MCP tools are read-only egress tools. Without this rule the next
 * call could put anything the agent knows into a URL of the attacker's choosing, with nobody
 * asked. So a run carries one piece of state, `EgressTaint`:
 *
 * - It is marked the first time a tool result with `external` untrusted provenance enters the
 *   context: web pages, API responses, search results, MCP results, peer answers, and the output
 *   of every shell or custom command (Jazz cannot tell what a command read, so any command
 *   output counts, which means egress after any shell command needs a person below `high-risk`).
 *   A run whose history holds such a result or host-recorded exposure starts marked, so resuming or continuing a
 *   conversation does not reset it. Sub-agents share their parent's taint in both directions.
 * - Once marked, an egress tool (`egress: true`) is no longer auto-approved by the `read-only`
 *   and `low-risk` tiers or by an unset policy: it prompts, parks, or is declined, exactly like
 *   any other call that needs a person. `high-risk` (and `true`) still approve it, and an explicit
 *   per-tool or per-command allowlist entry still counts.
 *
 * Two kinds of egress call stay automatic, because they cannot carry anything the run learned:
 *
 * - `FIXED_ENDPOINT_EGRESS_TOOLS`: tools that only talk to an endpoint the operator configured
 *   (`web_search` sends its query to the configured search provider, never to a model-chosen
 *   host).
 * - A plain GET (`web_fetch`, `read_pdf` by URL, `http_request` GET/HEAD with no headers, query
 *   or body) whose URL already appears, character for character, in the user's messages or in
 *   external content the run read. Following a link a page or search result contained tells its
 *   author nothing new; a URL the model composed is what needs a person.
 */

import type { ChatMessage } from "@/core/types/message";
import type { AutoApprovePolicy, EgressTaint } from "@/core/types/tools";
import { hasExternalUntrustedFrame } from "@/core/utils/untrusted-content";

/** Most sources an approval message lists; the rest are summarised as a count. */
const MAX_LISTED_SOURCES = 3;

/** Characters of the call's arguments an approval message shows. */
const MAX_ARGUMENT_PREVIEW_CHARS = 2_000;

/** Host metadata survives clearing; an existing external tool envelope is also restrictive. */
export function messageCarriesEgressTaint(message: ChatMessage): boolean {
  return (
    message.egressTainted === true ||
    (message.role === "tool" && hasExternalUntrustedFrame(message.content))
  );
}

/**
 * Taint state for a new run, marked already when `history` holds external untrusted content.
 */
export function createEgressTaint(history: readonly ChatMessage[] = []): EgressTaint {
  const recorded: string[] = [];
  let tainted = history.some(messageCarriesEgressTaint);
  if (tainted) {
    recorded.push("earlier in this conversation");
  }
  return {
    isTainted: () => tainted,
    sources: () => recorded,
    mark: (source) => {
      tainted = true;
      if (!recorded.includes(source)) {
        recorded.push(source);
      }
    },
  };
}

/** Egress tools whose destination is fixed by configuration rather than by the model. */
export const FIXED_ENDPOINT_EGRESS_TOOLS: ReadonlySet<string> = new Set(["web_search"]);

const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** The URL of a call that sends nothing but that URL, or undefined for any other call. */
function plainGetUrl(toolName: string, args: Record<string, unknown>): string | undefined {
  const url = args["url"];
  if (typeof url !== "string") {
    return undefined;
  }
  if (toolName === "web_fetch" || toolName === "read_pdf") {
    return url;
  }
  if (toolName === "http_request") {
    const method = typeof args["method"] === "string" ? args["method"].toUpperCase() : "";
    const sendsMore =
      args["body"] !== undefined || args["headers"] !== undefined || args["query"] !== undefined;
    return SAFE_HTTP_METHODS.has(method) && !sendsMore ? url : undefined;
  }
  return undefined;
}

function urlSpellings(url: string): readonly string[] {
  try {
    const normalized = new URL(url).toString();
    return normalized === url ? [url] : [url, normalized];
  } catch {
    return [url];
  }
}

/** Text the run did not write itself: the user's messages and external content it read. */
function knownText(messages: readonly ChatMessage[]): readonly string[] {
  return messages
    .filter(
      (message) =>
        message.role === "user" ||
        (message.role === "tool" && hasExternalUntrustedFrame(message.content)),
    )
    .map((message) => message.content);
}

function urlAlreadyKnown(url: string, messages: readonly ChatMessage[]): boolean {
  const texts = knownText(messages);
  return urlSpellings(url).some((spelling) => texts.some((text) => text.includes(spelling)));
}

/** Everything the taint gate needs to know about one call. */
export interface EgressGateInput {
  readonly toolName: string;
  readonly egress: boolean;
  readonly args: Record<string, unknown>;
  readonly policy: AutoApprovePolicy | undefined;
  readonly taint: EgressTaint | undefined;
  readonly messages: readonly ChatMessage[] | undefined;
}

/** Whether a policy tier still approves egress after untrusted content entered the run. */
export function policyApprovesTaintedEgress(policy: AutoApprovePolicy | undefined): boolean {
  return policy === true || policy === "high-risk";
}

/**
 * Whether this call must be put to a person because the run is tainted, even though its risk
 * tier would otherwise auto-approve it.
 */
export function taintedEgressNeedsApproval(input: EgressGateInput): boolean {
  if (!input.egress || input.taint?.isTainted() !== true) {
    return false;
  }
  if (policyApprovesTaintedEgress(input.policy)) {
    return false;
  }
  if (FIXED_ENDPOINT_EGRESS_TOOLS.has(input.toolName)) {
    return false;
  }
  if (input.toolName === "read_pdf" && input.args["url"] === undefined) {
    return false;
  }
  const url = plainGetUrl(input.toolName, input.args);
  if (url !== undefined && urlAlreadyKnown(url, input.messages ?? [])) {
    return false;
  }
  return true;
}

/** The approval text for a call the taint gate stopped. */
export function taintedEgressApprovalMessage(
  toolName: string,
  args: Record<string, unknown>,
  taint: EgressTaint,
): string {
  const sources = taint.sources();
  const listed = sources.slice(0, MAX_LISTED_SOURCES).join(", ");
  const more =
    sources.length > MAX_LISTED_SOURCES
      ? ` and ${String(sources.length - MAX_LISTED_SOURCES)} more`
      : "";
  const target = typeof args["url"] === "string" ? `\nDestination: ${args["url"]}` : "";
  return (
    `${toolName} sends data off this machine, and this run has read untrusted content ` +
    `(${listed}${more}).${target}\nArguments: ${JSON.stringify(args).slice(0, MAX_ARGUMENT_PREVIEW_CHARS)}\n` +
    "Approve it only if you expected this request."
  );
}
