/** @jsxImportSource @opentui/react */
// `.test.tsx` files land in the app tsconfig, which does not carry Bun's types.
// This pulls in the `bun:test` declaration alone: referencing all of `bun` would
// add every Bun global to the whole program and change `fetch` under it.
/// <reference types="bun-types/test" />

/**
 * The header and footer are the two rows that are always on screen, so their
 * failure modes are the ones a user meets every session: a row that overflows
 * the terminal, a meter that stays calm while the context fills, a footer that
 * silently drops the hint you needed.
 *
 * These assertions are about the design, not the implementation: they read the
 * characters and the real colours out of a rendered frame. The rest of the
 * suite runs with colour disabled, so this file is the one place where the
 * colour law is actually enforced rather than assumed.
 */

import type { CapturedFrame, CapturedSpan } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { getGlyphs } from "../glyphs";
import { setThemeVariant, THEME } from "../theme";
import { Footer } from "./Footer";
import { Header, headerGroups } from "./Header";
import type { Connector, FooterModel, HeaderModel } from "./types";

beforeAll(() => {
  process.env["JAZZ_UI_GLYPHS"] = "unicode";
  setThemeVariant("dark");
});

const LIVE: readonly Connector[] = [
  { name: "gmail", status: "live" },
  { name: "calendar", status: "live" },
  { name: "notion", status: "live" },
  { name: "slack", status: "live" },
];

function header(overrides: Partial<HeaderModel> = {}): HeaderModel {
  return {
    model: "opus-4",
    connectors: LIVE,
    contextUsed: 40_000,
    contextMax: 100_000,
    ...overrides,
  };
}

function footer(overrides: Partial<FooterModel> = {}): FooterModel {
  return {
    mode: "plan",
    hints: ["tab accept", "ctrl+r search"],
    costUsd: 0.42,
    elapsedMs: 95_000,
    personality: "house",
    ...overrides,
  };
}

interface Rendered {
  readonly row: string;
  readonly rows: readonly string[];
  readonly spans: readonly CapturedSpan[];
}

async function render(node: ReactNode, width: number, height = 3): Promise<Rendered> {
  const { renderOnce, captureCharFrame, captureSpans, renderer } = await testRender(node, {
    width,
    height,
  });
  await renderOnce();
  const rows = captureCharFrame()
    .split("\n")
    .filter((line) => line.length > 0);
  const frame: CapturedFrame = captureSpans();
  const spans = frame.lines[0]?.spans ?? [];
  renderer.destroy();
  return { row: rows[0] ?? "", rows, spans };
}

/** The captured colour of the first span whose text contains `needle`. */
function colorOf(spans: readonly CapturedSpan[], needle: string): string {
  const span = spans.find((candidate) => candidate.text.includes(needle));
  if (span === undefined) throw new Error(`no span containing ${JSON.stringify(needle)}`);
  const [red, green, blue] = span.fg.toInts();
  const hex = [red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("");
  return `#${hex.toUpperCase()}`;
}

describe("Header", () => {
  it("fills the row exactly and flushes the facts right", async () => {
    const { row, rows } = await render(
      <Header
        model={header()}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );

    expect([...row]).toHaveLength(80);
    // Right-aligned: the meter's percentage is the last thing on the row.
    expect(row.trimEnd()).toEndWith("%");
    expect([...row.trimEnd()]).toHaveLength(80);
    // One row, never two.
    expect((rows[1] ?? "").trim()).toBe("");
  });

  it("holds four fact groups and no more", async () => {
    const groups = headerGroups(header());
    expect(groups.length).toBeLessThanOrEqual(4);
    expect(groups.map((group) => group.key)).toEqual(["mark", "model", "connectors", "meter"]);

    const { row } = await render(
      <Header
        model={header()}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );
    const separators = [...row].filter((character) => character === getGlyphs().bullet);
    expect(separators.length).toBeLessThanOrEqual(3);
  });

  it("counts healthy connectors and names only the one needing action", async () => {
    const healthy = await render(
      <Header
        model={header()}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );
    expect(healthy.row).toContain("apps 4 of 4");

    const partial = await render(
      <Header
        model={header({
          connectors: [...LIVE.slice(0, 3), { name: "slack", status: "offline" }],
        })}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );
    expect(partial.row).toContain("apps 3 of 4");
    expect(partial.row).not.toContain("offline");

    const broken = await render(
      <Header
        model={header({
          connectors: [...LIVE.slice(0, 3), { name: "notion", status: "renew" }],
        })}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );
    expect(broken.row).toContain("notion renew");
    expect(broken.row).not.toContain("apps");
    // Nobody's fault: a warning, never error red.
    expect(colorOf(broken.spans, "notion renew")).toBe(THEME.warning.toUpperCase());
  });

  it("steps the meter to warning past 80% and error past 92%", async () => {
    const filled = getGlyphs().gridFilled;

    const calm = await render(
      <Header
        model={header({ contextUsed: 40_000 })}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );
    expect(colorOf(calm.spans, filled)).toBe(THEME.secondary.toUpperCase());

    const warning = await render(
      <Header
        model={header({ contextUsed: 85_000 })}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );
    expect(warning.row).toContain("85%");
    expect(colorOf(warning.spans, filled)).toBe(THEME.warning.toUpperCase());

    const error = await render(
      <Header
        model={header({ contextUsed: 95_000 })}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );
    expect(error.row).toContain("95%");
    expect(colorOf(error.spans, filled)).toBe(THEME.error.toUpperCase());
  });

  it("drops the model before the connectors or the meter", async () => {
    const long = header({ model: "anthropic/claude-opus-4-1-20250805" });
    const { row } = await render(
      <Header
        model={long}
        viewport={{ width: 60, height: 24 }}
      />,
      60,
    );

    expect([...row]).toHaveLength(60);
    expect(row).not.toContain("anthropic/");
    expect(row).toContain("apps 4 of 4");
    expect(row).toContain("40%");
  });
});

describe("Footer", () => {
  it("shows mode, hints, cost and elapsed, with the mode in the accent", async () => {
    const { row, rows, spans } = await render(
      <Footer
        model={footer()}
        viewport={{ width: 80, height: 24 }}
      />,
      80,
    );

    expect([...row]).toHaveLength(80);
    expect(row).toContain("plan");
    expect(row).toContain("tab accept");
    expect(row).toContain("$0.42");
    expect(row).toContain("1m 35s");
    expect((rows[1] ?? "").trim()).toBe("");

    expect(colorOf(spans, "plan")).toBe(THEME.primary.toUpperCase());
    // The dial is visible but dim — set, not imposed.
    expect(colorOf(spans, "house")).toBe(THEME.muted.toUpperCase());
    expect(colorOf(spans, "$0.42")).toBe(THEME.muted.toUpperCase());
  });

  it("drops elapsed before it drops a hint", async () => {
    const { row } = await render(
      <Footer
        model={footer()}
        viewport={{ width: 50, height: 24 }}
      />,
      50,
    );

    expect([...row]).toHaveLength(50);
    expect(row).not.toContain("1m 35s");
    expect(row).toContain("ctrl+r search");
    expect(row).toContain("$0.42");
  });

  it("drops hints from the end once elapsed is gone, keeping mode and cost", async () => {
    const { row } = await render(
      <Footer
        model={footer()}
        viewport={{ width: 40, height: 24 }}
      />,
      40,
    );

    expect([...row]).toHaveLength(40);
    expect(row).not.toContain("1m 35s");
    expect(row).not.toContain("ctrl+r search");
    expect(row).toContain("tab accept");
    expect(row).toContain("plan");
    expect(row).toContain("$0.42");
  });
});

describe("at the minimum width", () => {
  const viewport = { width: 60, height: 24 } as const;

  it("neither row overflows", async () => {
    const head = await render(
      <Header
        model={header()}
        viewport={viewport}
      />,
      60,
    );
    const foot = await render(
      <Footer
        model={footer({ hints: ["tab accept", "ctrl+r search", "esc stop"] })}
        viewport={viewport}
      />,
      60,
    );

    for (const { rows } of [head, foot]) {
      for (const line of rows) expect([...line].length).toBeLessThanOrEqual(60);
      expect([...(rows[0] ?? "")]).toHaveLength(60);
      expect((rows[1] ?? "").trim()).toBe("");
    }
  });
});
