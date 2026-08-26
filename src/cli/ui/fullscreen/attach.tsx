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

export interface FullscreenMountOptions {
  readonly mount?: typeof mountFullscreen;
  readonly onFailure?: (error: unknown) => void;
}

const KNOWN_OPEN_TUI_STARTUP_FAILURE =
  "Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet";

function isKnownOpenTuiStartupFailure(error: unknown): boolean {
  return String(error).includes(KNOWN_OPEN_TUI_STARTUP_FAILURE);
}

export function mountFullscreenApp(options: FullscreenMountOptions = {}): FullscreenHandle {
  let released = false;
  let teardown: (() => void) | null = null;
  const mount = options.mount ?? mountFullscreen;

  void mount()
    .then(({ renderer, release }) => {
      if (released) {
        release();
        return;
      }

      try {
        const root = createRoot(renderer);
        root.render(<FullscreenBridge />);
        teardown = () => {
          try {
            root.unmount();
          } finally {
            release();
          }
        };
      } catch (error) {
        release();
        throw error;
      }
    })
    .catch((error: unknown) => {
      if (released) return;
      if (!isKnownOpenTuiStartupFailure(error)) {
        process.stderr.write(
          `jazz: could not start the fullscreen interface (${String(error)}); using the standard interface\n`,
        );
      }
      options.onFailure?.(error);
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
