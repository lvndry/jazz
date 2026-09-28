/**
 * What a failed tool call did not do, and the one command that fixes it, for the
 * receipt that replaces the call in the transcript.
 *
 * "Did not happen" is only claimed for kinds of call whose failure leaves nothing
 * half-done: a send the service refused, a file written through an atomic replace,
 * a rename, a copy staged before it lands. A recursive delete or a shell command can
 * fail part-way, so their receipts state the reason and nothing more.
 */

import { actionClass, type ActionClass } from "@/cli/ui/fullscreen/approval-intent";

const NOT_DONE: Partial<Record<ActionClass, string>> = {
  send: "nothing was sent",
  write: "the file was not changed",
  edit: "the file was not changed",
  move: "nothing was moved",
  copy: "nothing was copied",
  create: "nothing was changed",
};

const MCP_TOOL = /^mcp_([a-z0-9-]+)_/;

/** The service rejected who jazz is signed in as, or that sign-in has lapsed. */
const AUTH_FAILURE =
  /\b(401|403|unauthori[sz]ed|forbidden|invalid[_ ]grant|token (?:has )?expired|expired token|re-?authenticate|not authenticated)\b/i;

/** The server behind the tool is not there to answer. */
const CONNECTION_FAILURE =
  /\b(econnrefused|econnreset|not connected|connection (?:closed|refused|lost)|server (?:is )?(?:not running|unavailable))\b/i;

export interface FailureOutcome {
  readonly notDone?: string;
  readonly remedy?: string;
}

export function failureOutcome(toolName: string, reason: string): FailureOutcome {
  const notDone = NOT_DONE[actionClass(toolName)];
  const server = MCP_TOOL.exec(toolName)?.[1];
  const remedy =
    server !== undefined && (AUTH_FAILURE.test(reason) || CONNECTION_FAILURE.test(reason))
      ? `/mcp reconnect ${server}`
      : undefined;
  return {
    ...(notDone === undefined ? {} : { notDone }),
    ...(remedy === undefined ? {} : { remedy }),
  };
}
