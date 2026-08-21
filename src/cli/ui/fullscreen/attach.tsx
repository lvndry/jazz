/** @jsxImportSource @opentui/react */
/**
 * Mounts the fullscreen interface from a synchronous call site.
 *
 * `createCliRenderer` is async because it probes the terminal, but the terminal
 * service constructs synchronously. Rather than make every caller await, this
 * starts the mount and returns a handle immediately: nothing renders until the
 * renderer is ready, and until then the store simply accumulates, so no output
 * is lost. `release()` is idempotent and safe to call before the mount has even
 * finished — which matters, because a user can quit during startup.
 */

import { createRoot } from "@opentui/react";
import { FullscreenBridge } from "./bridge";
import { mountFullscreen } from "./mount";

export { decideFullscreen, explainPlain } from "./mount";
export type { PlainReason } from "./mount";

export interface FullscreenHandle {
  readonly release: () => void;
}

/**
 * Fullscreen is opt-in while it is being built out.
 *
 * It is not yet at parity with the Ink tree, and a half-working alternate screen
 * is worse than no alternate screen: if it fails to paint, the user is left
 * looking at a blank terminal with no obvious way back. So the default path
 * stays the one that works, and fullscreen is asked for explicitly with
 * `--fullscreen` or `JAZZ_FULLSCREEN=1`.
 *
 * `--no-tui`, `--plain` and `--output raw|quiet` already mean "do not take over
 * the screen" and win over the opt-in, so a script that asks for plain output
 * cannot be surprised by a flag set in someone's shell profile.
 */
export function wantsPlainOutput(): boolean {
  const argv = process.argv;
  if (argv.includes("--no-tui") || argv.includes("--plain")) return true;
  const output = argv[argv.indexOf("--output") + 1];
  if (output === "raw" || output === "quiet") return true;

  const flag = process.env["JAZZ_FULLSCREEN"];
  const askedFor = argv.includes("--fullscreen") || flag === "1" || flag === "true";
  return !askedFor;
}

export function mountFullscreenApp(): FullscreenHandle {
  let released = false;
  let teardown: (() => void) | null = null;

  void mountFullscreen()
    .then(({ renderer, release }) => {
      if (released) {
        release();
        return;
      }
      const root = createRoot(renderer);
      root.render(<FullscreenBridge />);
      teardown = () => {
        root.unmount();
        release();
      };
    })
    .catch((error: unknown) => {
      // Falling back to whatever the terminal was doing is better than dying at
      // startup, but staying silent about it would leave the user wondering why
      // the interface never appeared.
      process.stderr.write(
        `jazz: could not start the fullscreen interface (${String(error)}); using plain output\n`,
      );
    });

  return {
    release: () => {
      if (released) return;
      released = true;
      teardown?.();
      teardown = null;
    },
  };
}
