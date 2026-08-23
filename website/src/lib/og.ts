/**
 * OG images are generated, not designed once: every page renders its own
 * 1200×630 at build time — the equalizer, the mark, the page's own title in
 * Anton. Deterministic per page (bars are seeded by the title), so rebuilds
 * don't churn bytes.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const WIDTH = 1200;
const HEIGHT = 630;
const BAR_COUNT = 40;
const BAR_GAP = 6;

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FONT_FILES = [
  join(websiteRoot, "node_modules/@expo-google-fonts/anton/400Regular/Anton_400Regular.ttf"),
  join(
    websiteRoot,
    "node_modules/@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf",
  ),
];

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const hash = (text: string): number => {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

/** Anton is narrow; ~0.47em per character is a safe planning width. */
const wrapTitle = (title: string): string[] => {
  const perLine = 26;
  if (title.length <= perLine) return [title];
  const words = title.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > perLine && current !== "") {
      lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.trim() !== "") lines.push(current.trim());
  if (lines.length > 2) {
    const kept = lines.slice(0, 2);
    kept[1] = `${(kept[1] ?? "").slice(0, perLine - 1)}…`;
    return kept;
  }
  return lines;
};

export function renderOgImage(title: string, subtitle: string): Buffer {
  const seed = hash(title);
  const barWidth = (WIDTH - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;
  const bars = Array.from({ length: BAR_COUNT }, (_, index) => {
    const value = ((seed >> (index % 24)) ^ (seed * (index + 3))) >>> 0;
    const fraction = 0.12 + ((value % 1000) / 1000) * 0.78;
    const barHeight = Math.round(fraction * HEIGHT * 0.42);
    const opacity = (0.2 + ((value % 700) / 700) * 0.55).toFixed(2);
    const x = index * (barWidth + BAR_GAP);
    return `<rect x="${x.toFixed(1)}" y="${HEIGHT - barHeight}" width="${barWidth.toFixed(1)}" height="${barHeight}" fill="#00D7FF" opacity="${opacity}"/>`;
  }).join("");

  const lines = wrapTitle(title);
  const fontSize = lines.length > 1 ? 88 : 104;
  const lineHeight = fontSize * 0.98;
  const baseY = HEIGHT - 150 - (lines.length - 1) * lineHeight;
  const titleText = lines
    .map(
      (line, index) =>
        `<text x="64" y="${baseY + index * lineHeight}" font-family="Anton" font-size="${fontSize}" fill="#E8EBEF" letter-spacing="1">${escapeXml(line.toUpperCase())}</text>`,
    )
    .join("");

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#07090B"/>
  <g opacity="0.5">${bars}</g>
  <rect x="64" y="56" width="26" height="26" fill="#00D7FF"/>
  <rect x="38" y="82" width="26" height="26" fill="#00D7FF"/>
  <text x="104" y="96" font-family="IBM Plex Mono" font-size="34" fill="#00D7FF">jazz</text>
  <text x="${WIDTH - 64}" y="96" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#5C6673">github.com/lvndry/jazz</text>
  ${titleText}
  <text x="64" y="${HEIGHT - 64}" font-family="IBM Plex Mono" font-size="24" fill="#A9B2BD" letter-spacing="3">${escapeXml(subtitle.toUpperCase())}</text>
</svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
