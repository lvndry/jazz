/**
 * Regenerates the token and glyph tables inside `docs/design/index.md` from the
 * modules that actually define them.
 *
 * A design document that restates hex values by hand starts drifting the first
 * time someone tunes a colour, and a drifted design doc is worse than none —
 * it teaches the wrong palette with authority. So the tables are generated,
 * and the prose around them is hand-written and left alone. The script only
 * ever rewrites the regions between the marker comments.
 *
 * Run with `bun run docs:design`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GLYPHS, type GlyphSet } from "../src/cli/ui/glyphs";
import { PALETTES, type ThemeColors, type ThemeVariant } from "../src/cli/ui/theme";

const DOC = path.join("docs", "design", "index.md");

/** Human-readable notes keyed by token, so the table says what a role is for. */
const TOKEN_NOTES: Partial<Record<keyof ThemeColors, string>> = {
  canvas: "the window's own ground",
  primary: "live, and your own affordances",
  agent: "live agent identity — the same accent, because the glyph says who",
  accentDim: "subordinate live content, links, citations",
  success: "it worked",
  error: "it broke",
  warning: "a scope worth noticing",
  info: "on the neutral ramp — info is not a hue",
  selected: "primary text",
  secondary: "secondary text",
  muted: "metadata, settled receipts, timestamps",
  reasoning: "live, but subordinate to an answer",
  syntaxStructure: "keywords and structure",
  syntaxValue: "strings, numbers, and inline code",
  syntaxType: "types and constructors",
};

/** Roles worth naming in the glyph table, in the order they are worth reading. */
const GLYPH_ROLES: readonly (readonly [keyof GlyphSet, string])[] = [
  ["note", "the mark"],
  ["promptCursor", "you are speaking"],
  ["diamond", "the agent is speaking"],
  ["proposed", "the agent is asking for authority"],
  ["success", "a tool succeeded"],
  ["error", "a tool failed"],
  ["warn", "needs attention, not broken"],
  ["pending", "not started"],
  ["active", "connected and live"],
  ["laneEnd", "a delegated lane closing"],
  ["rail", "speaker rail"],
  ["railDeep", "one level deeper"],
  ["blockquote", "quoted or subordinate text"],
  ["bullet", "list item"],
  ["divider", "rule"],
  ["ruleHeavy", "heavy rule, and the filled run of a meter"],
  ["gridFilled", "context used"],
  ["gridEmpty", "context free"],
];

function paletteTable(variant: ThemeVariant): string {
  const palette = PALETTES[variant];
  const rows = (Object.keys(palette) as (keyof ThemeColors)[]).map((key) => {
    const note = TOKEN_NOTES[key] ?? "";
    return `| \`${key}\` | \`${palette[key]}\` | ${note} |`;
  });
  return [`| Token | ${variant} | Role |`, "| --- | --- | --- |", ...rows].join("\n");
}

function glyphTable(): string {
  const rows = GLYPH_ROLES.map(([key, meaning]) => {
    const unicode = GLYPHS.unicode[key];
    const ascii = GLYPHS.ascii[key];
    // A pipe inside a table cell ends the cell, backticks or not.
    const show = (value: GlyphSet[keyof GlyphSet]): string =>
      typeof value === "string" ? `\`${value.replace(/\|/g, "\\|")}\`` : "";
    return `| ${show(unicode)} | ${show(ascii)} | ${meaning} |`;
  });
  return ["| Glyph | ASCII | Meaning |", "| --- | --- | --- |", ...rows].join("\n");
}

function indicatorTable(): string {
  const { lanePeriods, laneBurst, laneRest } = GLYPHS.unicode;
  const greatestCommonDivisor = (a: number, b: number): number =>
    b === 0 ? a : greatestCommonDivisor(b, a % b);
  const cycle = lanePeriods.reduce((a, b) => (a * b) / greatestCommonDivisor(a, b), 1);
  return [
    "| Property | Value |",
    "| --- | --- |",
    `| Lane periods | ${lanePeriods.join(", ")} frames |`,
    `| Burst | \`${laneBurst.join("")}\` — opening, live, closing |`,
    `| At rest | \`${laneRest}\` |`,
    `| Cycle before repeating | ${cycle} frames, about ${Math.round((cycle * 170) / 60000)} minutes at 170ms |`,
  ].join("\n");
}

const SECTIONS: Record<string, () => string> = {
  "palette-dark": () => paletteTable("dark"),
  "palette-light": () => paletteTable("light"),
  glyphs: glyphTable,
  indicator: indicatorTable,
};

let doc = readFileSync(DOC, "utf-8");
let replaced = 0;

for (const [name, render] of Object.entries(SECTIONS)) {
  const open = `<!-- generated:${name} -->`;
  const close = `<!-- /generated:${name} -->`;
  const start = doc.indexOf(open);
  const end = doc.indexOf(close);
  if (start === -1 || end === -1) {
    throw new Error(`missing markers for "${name}" in ${DOC} — expected ${open} … ${close}`);
  }
  doc = doc.slice(0, start + open.length) + "\n" + render() + "\n" + doc.slice(end);
  replaced++;
}

writeFileSync(DOC, doc);
console.log(`regenerated ${replaced} table(s) in ${DOC}`);
