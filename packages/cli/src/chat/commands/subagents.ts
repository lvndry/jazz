/**
 * @fileoverview The chat `/subagents` command: list every sub-agent this session ran, including
 * those from earlier turns that left the list under the composer, and print one's log.
 */

import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";
import {
  formatSubagentRun,
  resolveSubagentRun,
  subagentReport,
} from "@/cli/ui/models/subagent-report";
import { store } from "@/cli/ui/store";
import { builtinUsage } from "./constants";

export function handleSubagentsCommand(args: readonly string[]) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const runs = store.getAllSubagentRuns();
    const [subcommand, handle] = args;

    if (subcommand === undefined || subcommand.toLowerCase() === "list") {
      if (runs.length === 0) {
        yield* terminal.info("No sub-agents have run in this session.");
        return { shouldContinue: true };
      }
      const now = Date.now();
      for (const [index, run] of runs.entries()) {
        yield* terminal.log(formatSubagentRun(run, index + 1, now));
      }
      return { shouldContinue: true };
    }

    if (subcommand.toLowerCase() === "show") {
      const chosen = handle === undefined ? undefined : resolveSubagentRun(runs, handle);
      if (chosen === undefined) {
        yield* terminal.warn("Usage: /subagents show <number from /subagents list>");
        return { shouldContinue: true };
      }
      yield* terminal.log(subagentReport(chosen, Date.now()));
      return { shouldContinue: true };
    }

    yield* terminal.log(builtinUsage("subagents") ?? "");
    return { shouldContinue: true };
  });
}
