/** @jsxImportSource @opentui/react */
/**
 * Runs the fullscreen interface against the sample session, with no API key and
 * no agent loop.
 *
 * The point is to be able to look at the real thing — actual glyphs in your
 * actual terminal at your actual font — rather than at a mockup. A design that
 * only exists as a picture cannot be judged, and it cannot be regression-tested
 * by eye either.
 *
 *   bun run ui:demo
 *
 *   1  mid-session, two tools in flight
 *   2  the approval card
 *   3  history search across sessions
 *   4  idle, first run
 *   5  six tools, exercising the live zone's cap
 *   q  quit
 */

import { createRoot } from "@opentui/react";
import React, { useEffect, useState } from "react";
import { MOTION } from "../theme";
import { App } from "./App";
import { decideFullscreen, explainPlain, mountFullscreen } from "./mount";
import {
  sampleApprovalView,
  sampleBusyView,
  sampleIdleView,
  sampleSearchView,
  sampleView,
} from "./sample";
import type { ViewModel } from "./types";

const CTRL_C = "\x03";

const SCENES: Record<string, (tick: number) => ViewModel> = {
  "1": sampleView,
  "2": sampleApprovalView,
  "3": sampleSearchView,
  "4": () => sampleIdleView(),
  "5": sampleBusyView,
};

function Demo({ onQuit }: { onQuit: () => void }): React.ReactNode {
  const [scene, setScene] = useState("1");
  const [tick, setTick] = useState(0);

  // One timer for the whole interface. The indicator is the only thing that
  // animates, and it does so at the frame budget rather than as fast as it can.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), MOTION.indicator);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (chunk: Buffer): void => {
      const key = chunk.toString("utf8");
      if (key === "q" || key === CTRL_C) {
        onQuit();
        return;
      }
      if (SCENES[key] !== undefined) setScene(key);
    };
    process.stdin.on("data", onKey);
    return () => {
      process.stdin.off("data", onKey);
    };
  }, [onQuit]);

  const build = SCENES[scene] ?? sampleView;
  return (
    <App
      view={build(tick)}
      onAction={() => undefined}
    />
  );
}

async function main(): Promise<void> {
  const decision = decideFullscreen();
  if (!decision.fullscreen) {
    const reason = decision.reason ?? "requested";
    const message = explainPlain(reason, decision.width, decision.height);
    process.stderr.write(
      `${message ?? "This terminal cannot host the fullscreen interface."}\n` +
        `(reason: ${reason})\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { renderer, release } = await mountFullscreen();
  const root = createRoot(renderer);

  const quit = (): void => {
    root.unmount();
    release();
    process.exit(0);
  };

  root.render(<Demo onQuit={quit} />);
}

await main();
