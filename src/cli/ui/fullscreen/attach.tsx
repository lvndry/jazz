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
 * The fullscreen interface is the default. `--no-tui`, `--output raw|quiet` and
 * a non-interactive run are the opt-outs — there is no separate flag that turns
 * it *on*, because it is not a mode you ask for, it is what jazz is.
 *
 * `--no-tui` is commander's negated form of a `tui` boolean, so it surfaces as
 * `opts.tui === false`; there is no bare `--tui` to ask for the default back.
 * `JAZZ_FULLSCREEN=0` remains for a single run where even `--no-tui` is
 * inconvenient to pass (a wrapper script, a cron job).
 */
export function wantsPlainOutput(): boolean {
  const argv = process.argv;
  if (argv.includes("--no-tui")) return true;
  const output = argv[argv.indexOf("--output") + 1];
  if (output === "raw" || output === "quiet") return true;

  const flag = process.env["JAZZ_FULLSCREEN"];
  return flag === "0" || flag === "false";
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
