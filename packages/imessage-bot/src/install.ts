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
  /** Nothing to offer: say why and stop. */
  | { readonly action: "explain"; readonly message: string };

export interface PlanContext {
  /** Whether there is a person who can answer a prompt. */
  readonly interactive: boolean;
  readonly homebrewPresent: boolean;
}

const FULL_DISK_ACCESS_HELP =
  "macOS is refusing access to the message database.\n" +
  "Grant Full Disk Access to whatever runs this bridge — System Settings → " +
  "Privacy & Security → Full Disk Access — then start it again.\n" +
  "For a LaunchAgent that is the binary in ProgramArguments (e.g. the `bun` " +
  "executable), not Terminal.";

export function planInstall(availability: ImsgAvailability, context: PlanContext): InstallPlan {
  if (availability.available) return { action: "proceed" };

  // Reinstalling cannot grant a permission, so this never becomes an offer
  // however convenient that would be.
  if (availability.kind === "denied") {
    return { action: "explain", message: FULL_DISK_ACCESS_HELP };
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
      `Install it now with \`${IMSG_INSTALL_COMMAND}\`?`,
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
