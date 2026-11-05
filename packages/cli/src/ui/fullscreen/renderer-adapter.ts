/**
 * The boundary between Jazz's terminal ownership and OpenTUI's private renderer contract.
 *
 * React/native mutations already schedule demand frames. Full physical-screen
 * invalidation additionally needs OpenTUI's private repaint flag, because its
 * public requestRender only diffs intended buffers. Validate that contract on
 * acquisition and fail startup explicitly if it changes; never silently lose
 * blank-cell repair. Native frame presentation failures are also observed here
 * because OpenTUI logs them instead of emitting its public render:error.
 */

import type { CliRenderer } from "@opentui/core";

const REPAINT_FLAG = "forceFullRepaintRequested";
const PRESENT_SCENE_METHOD = "presentNativeScene";

export interface RendererInvalidation {
  readonly invalidate: () => void;
}

/** Fail closed if the pinned backend no longer supports physical-screen invalidation. */
export function rendererInvalidation(
  renderer: Pick<CliRenderer, "requestRender">,
): RendererInvalidation {
  if (typeof Reflect.get(renderer, REPAINT_FLAG) !== "boolean") {
    throw new Error("Unsupported OpenTUI repaint contract");
  }
  return {
    invalidate() {
      Reflect.set(renderer, REPAINT_FLAG, true);
      renderer.requestRender();
    },
  };
}

/** Observe rejected native frames through the pinned adapter, restoring the exact method on release. */
export function observeNativeFailure(
  renderer: CliRenderer,
  onFailure: (error: Error) => void,
): () => void {
  const original: unknown = Reflect.get(renderer, PRESENT_SCENE_METHOD);
  if (typeof original !== "function") {
    throw new Error("Unsupported OpenTUI native presentation contract");
  }
  const observed = async (): Promise<unknown> => {
    const result: unknown = await original.call(renderer);
    if (result === "failed") {
      onFailure(new Error("OpenTUI native output failed"));
    }
    return result;
  };
  Reflect.set(renderer, PRESENT_SCENE_METHOD, observed);
  return () => {
    if (Reflect.get(renderer, PRESENT_SCENE_METHOD) === observed) {
      Reflect.set(renderer, PRESENT_SCENE_METHOD, original);
    }
  };
}
