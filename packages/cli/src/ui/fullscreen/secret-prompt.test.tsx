/** @jsxImportSource @opentui/react */
/**
 * A secret typed in the fullscreen interface: bullets on screen while typing, Enter hands the
 * value to the run, Esc declines, and neither the frame nor the transcript ever shows the value.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { InkPresentationService } from "@/cli/presentation/ink-presentation-service";
import { store } from "../store";
import { FullscreenBridge } from "./bridge";
import { renderForTest } from "./test-helpers";

const WIDTH = 100;
const HEIGHT = 24;
const TYPED = "zq9x";

function presentation(): InkPresentationService {
  return new InkPresentationService(
    { showReasoning: true, showToolExecution: true, mode: "rendered", colorProfile: "full" },
    null,
  );
}

describe("fullscreen secret prompt", () => {
  beforeEach(() => {
    store.clearOutputs();
    store.setPrompt(null);
    store.setApprovalRequest(null);
    store.setActiveMenu(null);
  });

  it("draws bullets while typing and hands the value over on Enter", async () => {
    const rendered = await renderForTest(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    const pending = Effect.runPromise(
      presentation().requestSecretInput({ prompt: "Password for a.pdf", name: "pdf-password" }),
    );
    await rendered.flush();
    for (const key of TYPED) {
      await rendered.mockInput.pressKey(key);
      await rendered.flush();
    }
    const typing = rendered.captureCharFrame();
    expect(typing).toContain("Password for a.pdf");
    expect(typing).toContain("••••");
    expect(typing).not.toContain(TYPED);

    await rendered.mockInput.pressKey("RETURN");
    await rendered.flush();
    expect(await pending).toEqual({ kind: "provided", value: TYPED });
    store.flushOutputBatchNow();
    await rendered.flush();
    const after = rendered.captureCharFrame();
    expect(after).not.toContain(TYPED);
    expect(JSON.stringify(store.getOutputSnapshot().entries)).not.toContain(TYPED);
    rendered.renderer.destroy();
  });

  it("declines on Esc", async () => {
    const rendered = await renderForTest(<FullscreenBridge />, { width: WIDTH, height: HEIGHT });
    await rendered.renderOnce();
    const pending = Effect.runPromise(
      presentation().requestSecretInput({ prompt: "Token", name: "token" }),
    );
    await rendered.flush();
    await rendered.mockInput.pressKey("a");
    await rendered.mockInput.pressKey("ESCAPE");
    await rendered.flush();
    expect(await pending).toEqual({ kind: "declined" });
    expect(store.getPromptSlice().prompt).toBeNull();
    rendered.renderer.destroy();
  });
});
