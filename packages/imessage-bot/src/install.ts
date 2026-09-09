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
  | { readonly action: "grant"; readonly message: string; readonly grantPath: string }
  /** Nothing to offer: say why and stop. */
  | { readonly action: "explain"; readonly message: string };

export interface PlanContext {
  /** Whether there is a person who can answer a prompt. */
  readonly interactive: boolean;
  readonly homebrewPresent: boolean;
  /**
   * The binary to grant Full Disk Access to — this process's own executable.
   *
   * Under launchd that is what macOS holds responsible, which is the whole
   * reason to run the bridge that way: the grant covers the bridge rather than
   * a terminal and everything ever typed into it.
   */
  readonly grantPath: string;
}

const FULL_DISK_ACCESS_HELP =
  "macOS is refusing access to the message database (~/Library/Messages/chat.db).\n" +
  "\n" +
  "Why it is needed: Apple publishes no API for *receiving* iMessages, and the\n" +
  "AppleScript handler that once existed is gone — the row in chat.db is the only\n" +
  "record that a message arrived. Sending does not need this; that is the separate,\n" +
  "much narrower Automation → Messages grant.\n" +
  "\n" +
  "Why the permission is so broad: chat.db sits behind macOS's all-files privacy\n" +
  'class, and Apple offers no narrower "read Messages" grant to third-party\n' +
  "software. It is all files or nothing.\n" +
  "\n" +
  "Grant it in System Settings → Privacy & Security → Full Disk Access, then start\n" +
  "this again. macOS attributes the access to the *responsible* process, so from a\n" +
  "terminal that is the terminal app — which then also grants every other command\n" +
  "you run there. To keep the grant scoped to this bridge, run it from a\n" +
  "LaunchAgent and grant the binary in ProgramArguments instead.";

export function planInstall(availability: ImsgAvailability, context: PlanContext): InstallPlan {
  if (availability.available) return { action: "proceed" };

  // Reinstalling cannot grant a permission, so this never becomes an offer
  // however convenient that would be.
  if (availability.kind === "denied") {
    return context.interactive
      ? { action: "grant", message: FULL_DISK_ACCESS_HELP, grantPath: context.grantPath }
      : { action: "explain", message: FULL_DISK_ACCESS_HELP };
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
export async function openFullDiskAccessSettings(grantPath: string): Promise<void> {
  try {
    const pbcopy = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    await pbcopy.stdin.write(grantPath);
    await pbcopy.stdin.end();
    await pbcopy.exited;
  } catch {
    // Clipboard is a convenience, never the instruction.
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
