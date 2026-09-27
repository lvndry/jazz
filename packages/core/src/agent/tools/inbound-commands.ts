/**
 * Shell programs whose output is somebody else's words.
 *
 * Mail is the textbook prompt-injection channel, and Jazz reads mail through the shell
 * (`himalaya` in the email skill, `gcalcli`/`khal` for calendars) rather than through a tool of
 * its own. Output of a command that runs one of these programs is marked `external` untrusted
 * content: the loop frames it, and the run's egress taint is set (see `egress-taint.ts`).
 *
 * The match is on any word of the command whose basename is listed, so `cd ~/mail && himalaya
 * list` and `/usr/local/bin/curl …` both count. A listed name appearing as an argument
 * (`echo curl`) also counts; over-marking costs an approval prompt, under-marking costs the
 * guarantee.
 */

import type { UntrustedProvenance } from "@/core/types/tools";

/** Programs that print mail, calendar entries, web pages, API responses or forge content. */
export const INBOUND_CONTENT_PROGRAMS: ReadonlySet<string> = new Set([
  "himalaya",
  "notmuch",
  "mutt",
  "neomutt",
  "aerc",
  "fetchmail",
  "gcalcli",
  "khal",
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "lynx",
  "w3m",
  "links",
  "gh",
  "glab",
  "ssh",
]);

const WORD_SEPARATORS = /[\s;&|()<>`$"'{}]+/;

/** The listed program a command runs, or undefined when it runs none of them. */
export function inboundContentProgram(
  commandWords: string | readonly string[],
): string | undefined {
  const words =
    typeof commandWords === "string" ? commandWords.split(WORD_SEPARATORS) : commandWords;
  for (const word of words) {
    const basename = word.slice(word.lastIndexOf("/") + 1);
    if (INBOUND_CONTENT_PROGRAMS.has(basename)) {
      return basename;
    }
  }
  return undefined;
}

/** `external` provenance for the output of `command`, when it runs a listed program. */
export function inboundCommandProvenance(
  toolName: string,
  command: string | readonly string[],
): UntrustedProvenance | undefined {
  const program = inboundContentProgram(command);
  return program === undefined
    ? undefined
    : { kind: "external", source: `${toolName} output of ${program}` };
}
