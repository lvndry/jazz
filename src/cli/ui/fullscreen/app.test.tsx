/** @jsxImportSource @opentui/react */
/**
 * Whole-frame assertions for the fullscreen interface.
 *
 * The component tests check each region in isolation; these check the thing a
 * person actually sees. Because every region is a pure function of the view
 * model, a frame is reproducible from data alone — so the design's rules become
 * executable rather than aspirational. The density assertion in particular is
 * the calm-pass target as a contract: the first draft of this layout measured
 * 32% ink and was rejected as "very busy".
 */

import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { useState } from "react";
import { getGlyphs } from "../glyphs";
import { THEME } from "../theme";
import { App, reuseViewport } from "./App";
import { isPrintableSequence } from "./keymap";
import {
  sampleApprovalView,
  sampleBusyView,
  sampleIdleView,
  sampleSearchView,
  sampleView,
} from "./sample";
import { MIN_HEIGHT, MIN_WIDTH, type Block, type ViewModel } from "./types";

const WIDTH = 120;
const HEIGHT = 34;

interface Frame {
  readonly rows: readonly string[];
  readonly text: string;
}

async function frameOf(
  view: Parameters<typeof App>[0]["view"],
  width = WIDTH,
  height = HEIGHT,
): Promise<Frame> {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <App
      view={view}
      onAction={() => undefined}
    />,
    { width, height },
  );
  await renderOnce();
  const text = captureCharFrame();
  renderer.destroy();
  return { rows: text.split("\n").filter((row) => row.length > 0), text };
}

/** Cells that carry content, rather than space or frame chrome. */
const CHROME = new Set([..."─━│┃┌┐└┘├┤┬┴┼╴╶╺╻╹╵▎▏▐░▒▓█▚▖▘▝▗"]);

function inkDensity(rows: readonly string[]): number {
  const cells = rows.flatMap((row) => [...row]);
  const ink = cells.filter((cell) => cell !== " " && !CHROME.has(cell)).length;
  return ink / Math.max(1, cells.length);
}

function breathingShare(rows: readonly string[]): number {
  const quiet = rows.filter((row) => {
    const inked = [...row].filter((cell) => cell !== " ");
    return inked.length === 0 || inked.every((cell) => CHROME.has(cell));
  }).length;
  return quiet / Math.max(1, rows.length);
}

describe("fullscreen frame", () => {
  it("fills the terminal exactly, with chrome anchored top and bottom", async () => {
    const frame = await frameOf(sampleView());
    expect(frame.rows).toHaveLength(HEIGHT);
    for (const row of frame.rows) expect([...row]).toHaveLength(WIDTH);
  });

  it("paints the specified canvas as the window ground", async () => {
    const { renderer, renderOnce, captureSpans } = await testRender(
      <App
        view={sampleView()}
        onAction={() => undefined}
      />,
      { width: WIDTH, height: HEIGHT },
    );
    await renderOnce();
    const canvas = RGBA.fromHex(THEME.canvas).toInts().slice(0, 3).join(",");
    const painted = captureSpans()
      .lines.flatMap((line) => line.spans)
      .some((span) => span.bg.toInts().slice(0, 3).join(",") === canvas);
    renderer.destroy();
    expect(painted).toBe(true);
  });

  it("is calm enough to read: the density target the first draft failed", async () => {
    // Measured in Unicode glyph mode deliberately. In ASCII mode the divider is
    // 120 literal hyphens and the meter is dots — structure that a chrome set
    // cannot distinguish from prose punctuation, so the metric would count a
    // rule row as 120 cells of content and report a design problem that isn't
    // one. Unicode is also what the design targets and what a real terminal
    // gets.
    const previous = process.env["JAZZ_UI_GLYPHS"];
    process.env["JAZZ_UI_GLYPHS"] = "unicode";
    try {
      const frame = await frameOf(sampleView());
      // 32% ink was rejected as "very busy"; a well-set book page is around 10%.
      expect(inkDensity(frame.rows)).toBeLessThanOrEqual(0.22);
      expect(breathingShare(frame.rows)).toBeGreaterThanOrEqual(0.4);
    } finally {
      if (previous === undefined) delete process.env["JAZZ_UI_GLYPHS"];
      else process.env["JAZZ_UI_GLYPHS"] = previous;
    }
  });

  it("keeps the input anchored when the amount of running work changes", async () => {
    // This is the whole reason the live zone grows upward instead of downward:
    // the thing under the user's hands must not move as tools come and go.
    const idle = await frameOf(sampleIdleView());
    const busy = await frameOf(sampleBusyView());
    expect(idle.rows).toHaveLength(HEIGHT);
    expect(busy.rows).toHaveLength(HEIGHT);
    const idleInput = idle.rows.findIndex((row) => row.includes("Ask anything"));
    const busyInput = busy.rows.findIndex((row) => row.includes("Ask anything"));
    expect(idleInput).toBeGreaterThan(0);
    expect(busyInput).toBe(idleInput);
    // The composer never sits on the live band — one quiet row between them.
    expect(busy.rows[busyInput - 1]?.trim()).toBe("");
  });

  it("shows the whole approval card, naming the real account verbatim", async () => {
    const frame = await frameOf(sampleApprovalView());
    expect(frame.text).toContain("you@example.com");
    // Every field that will exist afterwards, before committing to it.
    expect(frame.text).toContain("15:00");
    expect(frame.text).toContain("Work");
    // Irreversibility as a sentence, not an icon.
    expect(frame.text.toLowerCase()).toContain("not undoable");
  });

  it("does not disturb the transcript when an overlay opens", async () => {
    const plain = await frameOf(sampleView());
    const overlaid = await frameOf(sampleApprovalView());

    // Rows the card cannot be covering must still carry the same content. An
    // overlay that reflowed the tree behind it would shift or drop lines here.
    const plainWords = new Set(plain.text.split(/\s+/).filter((word) => word.length > 6));
    const survivors = overlaid.text
      .split(/\s+/)
      .filter((word) => word.length > 6 && plainWords.has(word));
    expect(survivors.length).toBeGreaterThan(3);
  });

  it("opens search across sessions without losing the session behind it", async () => {
    const frame = await frameOf(sampleSearchView());
    expect(frame.text.toLowerCase()).toContain("basel");
    expect(frame.rows).toHaveLength(HEIGHT);
  });

  it("refuses to draw a partial frame below the minimum size", async () => {
    const frame = await frameOf(sampleView(), 40, 8);
    expect(frame.text).toContain(`${MIN_WIDTH}x${MIN_HEIGHT}`);
    expect(frame.text).toContain("40x8");
    // It says the way out rather than just complaining.
    expect(frame.text).toContain("--no-tui");
  });

  it("draws nothing from a font range the target fonts do not cover", async () => {
    // The strongest form of the glyph-safety rule: assert the actual output, so
    // a component sneaking in a checkmark or an arrow fails here even if it
    // never touches the glyph module. Verified ranges are ASCII, Latin-1,
    // General Punctuation, Math Operators, Box Drawing and Block Elements —
    // everything else risks a fallback glyph at a mismatched advance width.
    const safe = (codePoint: number): boolean =>
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xff) ||
      (codePoint >= 0x2000 && codePoint <= 0x206f) ||
      (codePoint >= 0x2200 && codePoint <= 0x22ff) ||
      (codePoint >= 0x2500 && codePoint <= 0x259f);

    for (const view of [
      sampleView(),
      sampleApprovalView(),
      sampleSearchView(),
      sampleBusyView(),
      sampleIdleView(),
    ]) {
      const frame = await frameOf(view);
      const offenders = [...new Set([...frame.text])]
        .filter((character) => character !== "\n")
        .filter((character) => !safe(character.codePointAt(0) ?? 0))
        .map(
          (character) =>
            `${character} (U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")})`,
        );
      expect(offenders).toEqual([]);
    }
  });

  it("holds its shape at the narrow end of the supported range", async () => {
    const frame = await frameOf(sampleView(), 80, 24);
    expect(frame.rows).toHaveLength(24);
    for (const row of frame.rows) expect([...row]).toHaveLength(80);
  });

  it("holds its shape on a very wide terminal and spends the extra columns", async () => {
    const frame = await frameOf(sampleView(), 200, 40);
    expect(frame.rows).toHaveLength(40);
    for (const row of frame.rows) expect([...row]).toHaveLength(200);
    expect(frame.rows.some((row) => row.trimEnd().length > 120)).toBe(true);
  });
});

function tallTranscriptView(): ViewModel {
  const blocks: Block[] = Array.from({ length: 40 }, (_, index) => ({
    id: `n${String(index)}`,
    seq: index + 1,
    kind: "notice",
    text: `line-${String(index).padStart(2, "0")} unique-marker`,
    tone: "info",
  }));
  const base = sampleIdleView();
  return { ...base, blocks };
}

async function settle(flush: () => Promise<void>, delayMs: 0 | 100 = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await flush();
}

describe("transcript wheel and type-to-input", () => {
  it("scrolls older conversation lines into view with the mouse wheel", async () => {
    const { renderer, renderOnce, flush, mockMouse, captureCharFrame } = await testRender(
      <App
        view={tallTranscriptView()}
        onAction={() => undefined}
      />,
      { width: 80, height: 16 },
    );
    await renderOnce();
    const atBottom = captureCharFrame();
    expect(atBottom).toContain("line-39");
    expect(atBottom).not.toContain("line-00");

    for (let step = 0; step < 40; step++) {
      await mockMouse.scroll(20, 6, "up");
      await settle(flush);
    }
    const scrolled = captureCharFrame();
    expect(scrolled).toContain("line-00");
    expect(scrolled).not.toContain("line-39");

    for (let step = 0; step < 40; step++) {
      await mockMouse.scroll(20, 6, "down");
      await settle(flush);
    }
    const back = captureCharFrame();
    renderer.destroy();
    expect(back).toContain("line-39");
    expect(back).not.toContain("line-00");
  });

  function TypeableApp(): React.ReactNode {
    const [draft, setDraft] = useState("");
    return (
      <App
        view={{
          ...tallTranscriptView(),
          input: {
            value: draft,
            placeholder: "Ask anything",
            queued: [],
            disabled: false,
          },
        }}
        onAction={() => undefined}
        onKey={(key) => {
          if (!isPrintableSequence(key.sequence, key.ctrl, key.super)) return false;
          setDraft((value) => value + key.sequence);
          return true;
        }}
        onPaste={(text) => {
          setDraft((value) => value + text);
          return true;
        }}
      />
    );
  }

  it("jumps to the composer and shows the typed character", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <TypeableApp />,
      { width: 80, height: 16 },
    );
    await renderOnce();
    await mockInput.pressKey("ESCAPE");
    await settle(flush, 100);
    expect(captureCharFrame()).toContain("type to input");

    await mockInput.pressKey("a");
    await settle(flush);
    const typed = captureCharFrame();
    renderer.destroy();
    expect(typed).toContain("a");
    expect(typed).toContain("enter to send");
  });

  it("pastes into the composer while the transcript has focus", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <TypeableApp />,
      { width: 80, height: 16 },
    );
    await renderOnce();
    await mockInput.pressKey("ESCAPE");
    await settle(flush, 100);
    expect(captureCharFrame()).toContain("type to input");

    await mockInput.pasteBracketedText("pasted-draft");
    await settle(flush);
    const pasted = captureCharFrame();
    renderer.destroy();
    expect(pasted).toContain("pasted-draft");
    expect(pasted).toContain("enter to send");
  });
});

describe("Ctrl+C", () => {
  async function pressCtrlC(
    mockInput: { pressKey: (key: string, mods?: object) => void },
    flush: () => Promise<void>,
    key: string | { name: string; ctrl: boolean },
  ): Promise<void> {
    if (typeof key === "string") mockInput.pressKey(key);
    else mockInput.pressKey(key.name, { ctrl: key.ctrl });
    await settle(flush, 100);
  }

  function stubSigint(): { readonly signals: string[]; readonly restore: () => void } {
    const originalKill = process.kill;
    const signals: string[] = [];
    process.kill = ((...args: unknown[]) => {
      signals.push(String(args[1] ?? ""));
      return true;
    }) as typeof process.kill;
    return {
      signals,
      restore: () => {
        process.kill = originalKill;
      },
    };
  }

  it("stops a run from a control byte or the letter+flag shape", async () => {
    for (const key of ["\x03", { name: "c", ctrl: true }] as const) {
      const actions: Array<{ type: string }> = [];
      const sigint = stubSigint();
      const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
        <App
          view={{
            ...sampleIdleView(),
            runActive: true,
            input: { value: "hello", placeholder: "Ask anything", queued: [], disabled: false },
          }}
          onAction={(action) => {
            actions.push(action);
          }}
        />,
        { width: 80, height: 16, exitOnCtrlC: false },
      );
      await renderOnce();
      await pressCtrlC(mockInput, flush, key);
      const frame = captureCharFrame();
      renderer.destroy();
      sigint.restore();
      expect(actions).toContainEqual({ type: "interrupt" });
      expect(sigint.signals).toEqual([]);
      expect(frame).toContain("hello");
      expect(frame).not.toMatch(/helloc/);
    }
  });

  it("quits at idle from a control byte or the letter+flag shape", async () => {
    for (const key of ["\x03", { name: "c", ctrl: true }] as const) {
      const actions: Array<{ type: string }> = [];
      const sigint = stubSigint();
      const { renderer, renderOnce, flush, mockInput } = await testRender(
        <App
          view={sampleIdleView()}
          onAction={(action) => {
            actions.push(action);
          }}
        />,
        { width: 80, height: 16, exitOnCtrlC: false },
      );
      await renderOnce();
      await pressCtrlC(mockInput, flush, key);
      renderer.destroy();
      sigint.restore();
      expect(actions.some((action) => action.type === "interrupt")).toBe(false);
      expect(sigint.signals).toEqual(["SIGINT"]);
    }
  });

  it("does not stop or quit on Cmd+C or Ctrl+Shift+C", async () => {
    const chords = [
      "\x1b[99;9u",
      "\x1b[99;6u",
      { name: "c", super: true },
      { name: "c", ctrl: true, shift: true },
    ] as const;
    for (const key of chords) {
      const actions: Array<{ type: string }> = [];
      const sigint = stubSigint();
      const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
        <App
          view={{
            ...sampleIdleView(),
            runActive: true,
            input: { value: "hello", placeholder: "Ask anything", queued: [], disabled: false },
          }}
          onAction={(action) => {
            actions.push(action);
          }}
        />,
        { width: 80, height: 16, exitOnCtrlC: false, kittyKeyboard: true },
      );
      await renderOnce();
      if (typeof key === "string") mockInput.pressKey(key);
      else mockInput.pressKey(key.name, key);
      await settle(flush, 100);
      const frame = captureCharFrame();
      renderer.destroy();
      sigint.restore();
      expect(actions.some((action) => action.type === "interrupt")).toBe(false);
      expect(sigint.signals).toEqual([]);
      expect(frame).toContain("hello");
      expect(frame).not.toMatch(/helloc/);
    }
  });

  it("does not quit at idle on Cmd+C or Ctrl+Shift+C", async () => {
    const chords = [
      "\x1b[99;9u",
      "\x1b[99;6u",
      { name: "c", super: true },
      { name: "c", ctrl: true, shift: true },
    ] as const;
    for (const key of chords) {
      const actions: Array<{ type: string }> = [];
      const sigint = stubSigint();
      const { renderer, renderOnce, flush, mockInput } = await testRender(
        <App
          view={sampleIdleView()}
          onAction={(action) => {
            actions.push(action);
          }}
        />,
        { width: 80, height: 16, exitOnCtrlC: false, kittyKeyboard: true },
      );
      await renderOnce();
      if (typeof key === "string") mockInput.pressKey(key);
      else mockInput.pressKey(key.name, key);
      await settle(flush, 100);
      renderer.destroy();
      sigint.restore();
      expect(actions.some((action) => action.type === "interrupt")).toBe(false);
      expect(sigint.signals).toEqual([]);
    }
  });
});

function completedTurnView(): ViewModel {
  const base = sampleView();
  return {
    ...base,
    live: { tools: [], hiddenTools: [], tick: 0, reservedRows: 0 },
    runActive: false,
    footer: {
      mode: base.footer.mode,
      hints: [],
    },
  };
}

function CompletedTurnApp(): React.ReactNode {
  const [draft, setDraft] = useState("");
  return (
    <App
      view={{
        ...completedTurnView(),
        input: {
          value: draft,
          placeholder: "Ask anything",
          queued: [],
          disabled: false,
        },
      }}
      onAction={() => undefined}
      onKey={(key) => {
        if (!isPrintableSequence(key.sequence, key.ctrl, key.super)) return false;
        setDraft((value) => value + key.sequence);
        return true;
      }}
    />
  );
}

describe("stable viewport identity", () => {
  it("reuses the previous object when width and height are unchanged", () => {
    const first = reuseViewport(120, 34, { width: 0, height: 0 });
    const same = reuseViewport(120, 34, first);
    const resized = reuseViewport(80, 34, same);
    expect(same).toBe(first);
    expect(resized).not.toBe(first);
    expect(resized).toEqual({ width: 80, height: 34 });
  });
});

describe("composer after a completed turn", () => {
  it("stays on screen and shows the next typed character", async () => {
    const { renderer, renderOnce, flush, mockInput, captureCharFrame } = await testRender(
      <CompletedTurnApp />,
      { width: 80, height: 16 },
    );
    await renderOnce();
    const idle = captureCharFrame();
    expect(idle).toContain(getGlyphs().promptCursor);
    expect(idle).toContain("enter to send");

    await mockInput.pressKey("x");
    await settle(flush);
    const typed = captureCharFrame();
    renderer.destroy();
    expect(typed).toContain(getGlyphs().promptCursor);
    expect(typed).toContain("x");
    expect(typed).toContain("enter to send");
  });
});
