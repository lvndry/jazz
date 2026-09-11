/**
 * @fileoverview Getting `imsg` onto the machine, rather than telling someone to.
 *
 * The bridge depends on a CLI that is almost certainly not installed the first
 * time anyone runs it. Exiting with "install this and come back" makes setup a
 * two-step job for something that is one `brew install`, so when there is a
 * person at the terminal the bridge offers to do it.
 *
 * What it will not do is install without asking, or install in a context where
 * nobody is there to be asked — a LaunchAgent starting at login gets the
 * instructions and a non-zero exit instead, because an unattended process
 * reaching out to a package manager is a surprise nobody consented to.
 *
 * The decision is kept separate from the doing so the rules can be tested
 * without a package manager or a terminal.
 */

import type { ImsgAvailability } from "./imsg";

export const IMSG_FORMULA = "steipete/tap/imsg";
export const IMSG_INSTALL_COMMAND = `brew install ${IMSG_FORMULA}`;

/** What the bridge should do about `imsg` not being usable. */
export type InstallPlan =
  | { readonly action: "proceed" }
  /** Ask the person, and install if they agree. */
  | { readonly action: "offer"; readonly message: string }
  /**
   * Walk the person to the one step software cannot take.
   *
   * Full Disk Access is the only TCC class Apple gives no request API for —
   * there is no prompt a program can raise, so this opens the right settings
   * pane and puts the path on the clipboard instead of leaving someone to find
   * both by hand.
   */
  | { readonly action: "grant"; readonly message: string; readonly grant: GrantTarget }
  /** Nothing to offer: say why and stop. */
  | { readonly action: "explain"; readonly message: string };

/**
 * What has to appear in the Full Disk Access list: the process macOS holds
 * responsible — the terminal you started the binary from, or the binary itself
 * under launchd.
 */
export interface GrantTarget {
  readonly kind: "self" | "launcher";
  /** What to look for in the list, e.g. "Jazz" or "Ghostty". */
  readonly label: string;
  /** Path to paste, for a binary no file picker opens at. */
  readonly path: string | undefined;
}

export interface PlanContext {
  /** Whether there is a person who can answer a prompt. */
  readonly interactive: boolean;
  readonly homebrewPresent: boolean;
  readonly grant: GrantTarget;
}

/** Terminal emulators by the `TERM_PROGRAM` they advertise. */
const TERMINAL_APP_NAMES: Readonly<Record<string, string>> = {
  Apple_Terminal: "Terminal",
  "iTerm.app": "iTerm",
  ghostty: "Ghostty",
  WarpTerminal: "Warp",
  WezTerm: "WezTerm",
  Hyper: "Hyper",
  vscode: "Visual Studio Code",
  Tabby: "Tabby",
  rio: "Rio",
  alacritty: "Alacritty",
  kitty: "kitty",
};

/** The terminal this process was started from; unknown ones keep their own name. */
export function terminalAppName(env: NodeJS.ProcessEnv = process.env): string {
  const program = env["TERM_PROGRAM"]?.trim() ?? "";
  if (program.length === 0) return "your terminal app";
  return TERMINAL_APP_NAMES[program] ?? program;
}

/**
 * What to say when macOS blocks the message database.
 *
 * Short and matter-of-fact. This is a setup step, not an incident: an earlier
 * version explained the whole TCC responsible-process model here and read like
 * a security warning, which is the wrong tone for someone three minutes into
 * trying a chat bridge. The detail lives in the README for anyone who wants it.
 *
 * It does say why it names a terminal and not Jazz, which otherwise reads like
 * a mistake someone will "fix" by adding the binary.
 */
function fullDiskAccessHelp(grant: GrantTarget): string {
  const why =
    "macOS keeps messages in a protected database, and this is the only permission\n" +
    "that can open it. It is what lets the agent see the messages you send it.";

  if (grant.kind === "self") {
    return `Jazz needs Full Disk Access to read your Messages.\n\n${why}`;
  }

  return (
    `${grant.label} needs Full Disk Access so Jazz can read your Messages.\n` +
    "\n" +
    `${why}\n` +
    "\n" +
    `macOS grants this to whatever started Jazz, so it has to name ${grant.label}\n` +
    "rather than Jazz itself — which also means every command you run there gets\n" +
    "it. Installing the background service narrows the grant to Jazz alone."
  );
}

export function planInstall(availability: ImsgAvailability, context: PlanContext): InstallPlan {
  if (availability.available) return { action: "proceed" };

  // Reinstalling cannot grant a permission, so this never becomes an offer
  // however convenient that would be.
  if (availability.kind === "denied") {
    const message = fullDiskAccessHelp(context.grant);
    return context.interactive
      ? { action: "grant", message, grant: context.grant }
      : { action: "explain", message };
  }
  if (availability.kind === "failed") {
    return { action: "explain", message: availability.reason };
  }

  if (!context.homebrewPresent) {
    return {
      action: "explain",
      message:
        `${availability.reason}\n` +
        "Homebrew is not installed either, so it cannot be fetched automatically.\n" +
        "Install Homebrew from https://brew.sh and run: " +
        `${IMSG_INSTALL_COMMAND}\n` +
        "Or build it from source: https://github.com/openclaw/imsg",
    };
  }

  if (!context.interactive) {
    return {
      action: "explain",
      message:
        `${availability.reason}\n` +
        `Nothing is attached to this process to ask, so it will not install anything on its own.\n` +
        `Run this once from a terminal: ${IMSG_INSTALL_COMMAND}`,
    };
  }

  return {
    action: "offer",
    message:
      `${availability.reason}\n\n` +
      "The iMessage bridge reads Messages through `imsg`, an open-source (MIT) CLI:\n" +
      "  https://github.com/openclaw/imsg\n\n" +
      `It can be installed now with \`${IMSG_INSTALL_COMMAND}\`.`,
  };
}

/**
 * Read a yes/no answer, defaulting to yes on a bare Enter.
 *
 * Written against stdin directly rather than Bun's `prompt`, which returns null
 * on a closed stream in a way that is indistinguishable from a refusal — and
 * "the stream ended" has to mean no, not silence that gets read as consent.
 */
export async function confirm(question: string): Promise<boolean> {
  process.stderr.write(`${question} [Y/n] `);
  for await (const chunk of process.stdin) {
    const answer = new TextDecoder()
      .decode(chunk as Uint8Array)
      .trim()
      .toLowerCase();
    if (answer.length === 0) return true;
    return answer === "y" || answer === "yes";
  }
  return false;
}

/** The System Settings pane holding the Full Disk Access list. */
const FULL_DISK_ACCESS_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/**
 * Open the settings pane and put the path on the clipboard.
 *
 * The path is the fiddly half: the file picker opens at /Applications and a
 * unix path can only be typed into its Cmd-Shift-G dialog, so having it ready
 * to paste is most of the work. Both halves are best-effort — the message
 * printed alongside already says what to do if either fails.
 */
export async function openFullDiskAccessSettings(grantPath?: string): Promise<void> {
  // An app is picked by name; a stale path on the clipboard is worse than none.
  if (grantPath !== undefined) {
    try {
      const pbcopy = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      await pbcopy.stdin.write(grantPath);
      await pbcopy.stdin.end();
      await pbcopy.exited;
    } catch {
      // Clipboard is a convenience, never the instruction.
    }
  }
  try {
    const open = Bun.spawn(["open", FULL_DISK_ACCESS_PANE], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await open.exited;
  } catch {
    // Older or locked-down systems may not route the URL; the path is printed.
  }
}

/** Run the install, streaming its output so a slow build does not look hung. */
export async function installImsg(): Promise<boolean> {
  console.error(`\nRunning: ${IMSG_INSTALL_COMMAND}\n`);
  const child = Bun.spawn(["brew", "install", IMSG_FORMULA], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    console.error(`\nInstall failed (exit ${exitCode}). Run it by hand: ${IMSG_INSTALL_COMMAND}`);
    return false;
  }
  return true;
}

export async function homebrewPresent(): Promise<boolean> {
  try {
    const child = Bun.spawn(["brew", "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
