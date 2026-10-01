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
 *
 * The handle exposes title and physical invalidation as deliberate capabilities.
 * Runtime React, handler and native output failures release the terminal before
 * notifying the caller once, so it can render the existing document on fallback.
 * No action is replayed; Jazz's handoff diagnostic excludes document/error details.
 */

import type { CliRendererErrorEvent } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Component, type ReactNode } from "react";
import { FullscreenBridge } from "./bridge";
import { mountFullscreen } from "./mount";
import { observeNativeFailure, rendererInvalidation } from "./renderer-adapter";
import { TerminalScope } from "./terminal-scope";
import { useThemeRevision } from "./theme-revision";

/**
 * Re-renders the whole interface when the theme changes. The bridge element is created on each
 * render, so every component below it re-renders too; memoised regions opt in themselves.
 */
function ThemedBridge(): ReactNode {
  useThemeRevision();
  return <FullscreenBridge />;
}

export interface FullscreenHandle {
  readonly release: () => void;
  /** Queue during acquisition; remove controls before invoking the native title capability. */
  readonly setTitle: (title: string) => void;
  /** Repaint every physical cell through the renderer, including intended blanks. */
  readonly invalidate: () => void;
}

export interface FullscreenMountOptions {
  readonly mount?: typeof mountFullscreen;
  readonly onFailure?: (error: unknown) => void;
}

/** A failed React commit hands off the existing document; it never restarts an agent action. */
class RuntimeBoundary extends Component<
  { readonly children: ReactNode; readonly onFailure: (error: unknown) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onFailure(error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function mountFullscreenApp(options: FullscreenMountOptions = {}): FullscreenHandle {
  let released = false;
  let failureScheduled = false;
  let teardown: (() => void) | null = null;
  let title: string | undefined;
  let applyTitle: ((title: string) => void) | undefined;
  let invalidate: (() => void) | undefined;
  const mount = options.mount ?? mountFullscreen;

  const fail = (error: unknown): void => {
    if (released || failureScheduled) return;
    failureScheduled = true;
    queueMicrotask(() => {
      if (released) return;
      released = true;
      try {
        teardown?.();
      } catch {
        // Cleanup was exhausted; rendering failure still hands off exactly once.
      } finally {
        teardown = null;
        applyTitle = undefined;
        invalidate = undefined;
        title = undefined;
        try {
          process.stderr.write("jazz: fullscreen interface failed; using the standard interface\n");
        } finally {
          options.onFailure?.(error);
        }
      }
    });
  };

  void mount()
    .then(({ renderer, release }) => {
      if (released) {
        release();
        return;
      }
      const scope = new TerminalScope();
      scope.add(release);
      teardown = () => scope.release();
      const effects = rendererInvalidation(renderer);
      scope.add(observeNativeFailure(renderer, fail));
      const onError = (event: CliRendererErrorEvent): void => fail(event.error);
      renderer.on("render:error", onError);
      scope.add(() => renderer.off("render:error", onError));
      renderer.on("handler:error", onError);
      scope.add(() => renderer.off("handler:error", onError));
      const root = createRoot(renderer);
      scope.add(() => root.unmount());
      applyTitle = (next) => {
        if (!renderer.isDestroyed) renderer.setTerminalTitle(next);
      };
      invalidate = () => {
        if (!renderer.isDestroyed) effects.invalidate();
      };
      if (title !== undefined) applyTitle(title);
      root.render(
        <RuntimeBoundary onFailure={fail}>
          <ThemedBridge />
        </RuntimeBoundary>,
      );
    })
    .catch(fail);

  return {
    setTitle(next) {
      if (released || failureScheduled) return;
      title = next.replace(/\p{Cc}/gu, "");
      try {
        applyTitle?.(title);
      } catch (error) {
        fail(error);
      }
    },
    invalidate() {
      if (released || failureScheduled) return;
      try {
        invalidate?.();
      } catch (error) {
        fail(error);
      }
    },
    release() {
      if (released) return;
      released = true;
      try {
        teardown?.();
      } finally {
        teardown = null;
        applyTitle = undefined;
        invalidate = undefined;
        title = undefined;
      }
    },
  };
}
