/**
 * The version boundary between Jazz's terminal ownership and OpenTUI 0.5.11.
 *
 * React/native mutations already schedule demand frames. Full physical-screen
 * invalidation additionally needs OpenTUI's private repaint flag, because its
 * public requestRender only diffs intended buffers. Validate that contract on
 * acquisition and fail startup explicitly if it changes; never silently lose
 * blank-cell repair. Native writer failures are also observed here because
 * this OpenTUI version logs them instead of emitting its public render:error.
 */

import type { CliRenderer } from "@opentui/core";

export interface RendererInvalidation {
  readonly invalidate: () => void;
}

/** Fail closed if the pinned backend no longer supports physical-screen invalidation. */
export function rendererInvalidation(
  renderer: Pick<CliRenderer, "requestRender">,
): RendererInvalidation {
  const backend = renderer as unknown as { forceFullRepaintRequested?: unknown };
  if (typeof backend.forceFullRepaintRequested !== "boolean") {
    throw new Error("Unsupported OpenTUI repaint contract");
  }
  return {
    invalidate() {
      backend.forceFullRepaintRequested = true;
      renderer.requestRender();
    },
  };
}

/** Observe rejected native frames through the pinned adapter, restoring the exact method on release. */
export function observeNativeFailure(
  renderer: CliRenderer,
  onFailure: (error: Error) => void,
): () => void {
  const backend = renderer as unknown as { renderNative?: () => unknown };
  const original = backend.renderNative;
  if (typeof original !== "function") throw new Error("Unsupported OpenTUI native writer contract");
  const observed = (): unknown => {
    const result = original.call(renderer);
    if (result === "failed") onFailure(new Error("OpenTUI native output failed"));
    return result;
  };
  backend.renderNative = observed;
  return () => {
    if (backend.renderNative === observed) backend.renderNative = original;
  };
}
