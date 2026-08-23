/** @jsxImportSource @opentui/react */

import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { memo, useRef } from "react";
import { MOTION } from "../theme";
import { App } from "./App";
import { Header } from "./Header";
import { Input } from "./Input";
import { LiveZone } from "./LiveZone";
import { sampleView } from "./sample";
import { transcriptRows } from "./Transcript";
import type { HeaderModel, InputModel, ViewModel, Viewport } from "./types";

const WIDTH = 120;
const HEIGHT = 34;

function waitForLiveTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MOTION.indicator * 2 + 40));
}

describe("live tick isolation", () => {
  it("does not commit App when the live indicator advances", async () => {
    let commits = 0;
    function CountingApp({ view }: { view: ViewModel }): React.ReactNode {
      commits += 1;
      return (
        <App
          view={view}
          onAction={() => undefined}
        />
      );
    }

    const view = sampleView();
    const { renderer, renderOnce, flush } = await testRender(<CountingApp view={view} />, {
      width: WIDTH,
      height: HEIGHT,
    });
    await renderOnce();
    const afterMount = commits;

    await waitForLiveTick();
    await flush();
    renderer.destroy();

    expect(commits).toBe(afterMount);
  });

  it("keeps Header and Input props referentially stable across ticks", async () => {
    const view = sampleView();
    const viewport: Viewport = { width: WIDTH, height: HEIGHT };
    const headerModels: HeaderModel[] = [];
    const inputModels: InputModel[] = [];

    const HeaderProbe = memo(function HeaderProbe({
      model,
      viewport: nextViewport,
    }: {
      model: HeaderModel;
      viewport: Viewport;
    }): React.ReactNode {
      headerModels.push(model);
      return (
        <Header
          model={model}
          viewport={nextViewport}
        />
      );
    });

    const InputProbe = memo(function InputProbe({
      model,
      viewport: nextViewport,
    }: {
      model: InputModel;
      viewport: Viewport;
    }): React.ReactNode {
      inputModels.push(model);
      return (
        <Input
          model={model}
          viewport={nextViewport}
          focused
        />
      );
    });

    function Shell(): React.ReactNode {
      return (
        <box style={{ width: WIDTH, height: HEIGHT, flexDirection: "column" }}>
          <HeaderProbe
            model={view.header}
            viewport={viewport}
          />
          <LiveZone
            model={view.live}
            viewport={viewport}
          />
          <InputProbe
            model={view.input}
            viewport={viewport}
          />
        </box>
      );
    }

    const { renderer, renderOnce, flush } = await testRender(<Shell />, {
      width: WIDTH,
      height: HEIGHT,
    });
    await renderOnce();
    expect(headerModels.length).toBeGreaterThan(0);
    expect(inputModels.length).toBeGreaterThan(0);
    const headersAfterMount = headerModels.length;
    const inputsAfterMount = inputModels.length;

    await waitForLiveTick();
    await flush();
    renderer.destroy();

    expect(headerModels).toHaveLength(headersAfterMount);
    expect(inputModels).toHaveLength(inputsAfterMount);
    expect(headerModels.every((model) => model === view.header)).toBe(true);
    expect(inputModels.every((model) => model === view.input)).toBe(true);
  });

  it("does not re-enter transcriptRows when the live indicator advances", async () => {
    const view = sampleView();
    const viewport: Viewport = { width: WIDTH, height: HEIGHT };
    const builds: number[] = [];

    function TranscriptProbe(): React.ReactNode {
      const countRef = useRef(0);
      countRef.current += 1;
      builds.push(countRef.current);
      transcriptRows(view.blocks, viewport);
      return <text>probe</text>;
    }

    function Shell(): React.ReactNode {
      return (
        <box style={{ width: WIDTH, height: HEIGHT, flexDirection: "column" }}>
          <TranscriptProbe />
          <LiveZone
            model={view.live}
            viewport={viewport}
          />
        </box>
      );
    }

    const { renderer, renderOnce, flush } = await testRender(<Shell />, {
      width: WIDTH,
      height: HEIGHT,
    });
    await renderOnce();
    const afterMount = builds.length;

    await waitForLiveTick();
    await flush();
    renderer.destroy();

    expect(builds).toHaveLength(afterMount);
  });
});
