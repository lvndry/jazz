import type { TerminalOutput, TerminalService } from "@jazz/core/interfaces/terminal";
import { isTerminalReport } from "@jazz/core/interfaces/terminal";
import { Effect } from "effect";
import type { CommandPanelEntry, CommandPanelTone } from "@/cli/ui/command-panel";
import { store } from "@/cli/ui/store";
import type { SpecialCommand } from "./types";

/**
 * Whether a command only reads, so it can answer at once in the command panel, even mid-turn,
 * instead of waiting in the queue for the turn to end. Forms that change something
 * (`/mcp reconnect`, `/work clear`, `/memory forget`, `/waits cancel`) still queue.
 *
 * `/theme` counts: switching it repaints the screen and saves a setting, but touches nothing the
 * agent reads.
 */
export function runsImmediately(command: SpecialCommand): boolean {
  const [subcommand] = command.args;
  switch (command.type) {
    case "info":
    case "cost":
    case "context":
    case "help":
    case "tools":
    case "peers":
    case "theme":
      return true;
    case "mcp":
    case "work":
      return subcommand === undefined;
    case "memory":
      return subcommand !== "forget";
    case "waits":
      return subcommand === undefined || subcommand.toLowerCase() === "list";
    default:
      return false;
  }
}

/**
 * `base` with every line of output sent to a new command panel instead of the transcript.
 * Prompts still go through `base`, so `/theme`'s picker opens as usual.
 */
export function commandPanelTerminal(base: TerminalService, command: string): TerminalService {
  const panelId = store.beginCommandPanel();
  const show = (entry: CommandPanelEntry): Effect.Effect<void> =>
    Effect.sync(() => store.appendCommandPanel(panelId, command, entry));
  const text =
    (tone: CommandPanelTone) =>
    (message: string): Effect.Effect<void> =>
      show({ kind: "text", tone, text: message });
  return {
    isInteractive: base.isInteractive,
    user: base.user.bind(base),
    debug: base.debug.bind(base),
    ask: base.ask.bind(base),
    password: base.password.bind(base),
    select: base.select.bind(base),
    confirm: base.confirm.bind(base),
    search: base.search.bind(base),
    checkbox: base.checkbox.bind(base),
    setTitle: base.setTitle.bind(base),
    info: text("info"),
    success: text("success"),
    warn: text("warn"),
    error: text("error"),
    heading: text("info"),
    list: (items: string[]) => text("log")(items.join("\n")),
    log: (message: TerminalOutput) =>
      show(
        isTerminalReport(message)
          ? { kind: "report", report: message }
          : { kind: "text", tone: "log", text: message },
      ).pipe(Effect.as(undefined)),
    clear: () => Effect.void,
  };
}
