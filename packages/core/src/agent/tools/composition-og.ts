/**
 * Jazz-styled OG cards for published compositions: the same design language
 * as the website OG images (1200x630, seeded equalizer, the ▞ lockup mark,
 * Anton title, IBM Plex Mono), with a "made with jazz" signature so shares
 * read as compositions. Deterministic per title — rebuilding produces the
 * same bytes.
 *
 * The lockup geometry is a copy of packages/website/src/lib/logo.ts (the one
 * geometry every rendered logo is built from); core keeps its own copy to
 * stay decoupled from the website package.
 */
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";

const WIDTH = 1200;
const HEIGHT = 630;
const BAR_COUNT = 40;
const BAR_GAP = 6;

// Core is not bundled per-page, so plain resolution works; the createRequire
// form is kept so this keeps working if the module is ever bundled.
const requireFromHere = createRequire(import.meta.url);
const FONT_FILES = [
  requireFromHere.resolve("@expo-google-fonts/anton/400Regular/Anton_400Regular.ttf"),
  requireFromHere.resolve("@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf"),
];

// From packages/website/src/lib/logo.ts — keep in sync.
const BRAND_CYAN = "#00D7FF";
const LOCKUP_BOX = { x: 56, y: -24, width: 264, height: 104 } as const;
const WORDMARK_SHAPES = [
  `<path d="M140 0 H152 V80 H124 V68 H140 Z"/>`,
  `<rect x="140" y="-24" width="12" height="12"/>`,
  `<path d="M164 0 H208 V60 H164 V24 H196 V12 H164 Z M176 36 V48 H196 V36 Z"/>`,
  `<path d="M220 0 H264 V12 L235 48 H264 V60 H220 V48 L249 12 H220 Z"/>`,
  `<path d="M276 0 H320 V12 L291 48 H320 V60 H276 V48 L305 12 H276 Z"/>`,
].join("");

/** Lockup sits top-left, 60px tall, its wordmark baseline on the 96px baseline. */
const LOCKUP_HEIGHT = 60;
const HEADER_BASELINE = 96;
const LOCKUP_SCALE = LOCKUP_HEIGHT / LOCKUP_BOX.height;
const LOCKUP_TOP = HEADER_BASELINE - 84 * LOCKUP_SCALE;

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
  const perLine = 24;
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

export type CompositionOgOptions = {
  /** Optional short handle shown next to the signature, e.g. "@lvndry". */
  readonly author?: string;
};

/** Render the composition OG card as PNG bytes. */
export function renderCompositionOg(title: string, options: CompositionOgOptions = {}): Buffer {
  const seed = hash(title);
  const barWidth = (WIDTH - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;
  const bars = Array.from({ length: BAR_COUNT }, (_, index) => {
    const value = ((seed >> (index % 24)) ^ (seed * (index + 3))) >>> 0;
    const fraction = 0.12 + ((value % 1000) / 1000) * 0.78;
    const barHeight = Math.round(fraction * HEIGHT * 0.42);
    const opacity = (0.2 + ((value % 700) / 700) * 0.55).toFixed(2);
    const x = index * (barWidth + BAR_GAP);
    return `<rect x="${x.toFixed(1)}" y="${HEIGHT - barHeight}" width="${barWidth.toFixed(1)}" height="${barHeight}" fill="${BRAND_CYAN}" opacity="${opacity}"/>`;
  }).join("");

  const lines = wrapTitle(title);
  const fontSize = lines.length > 1 ? 84 : 98;
  const lineHeight = fontSize * 0.98;
  const baseY = HEIGHT - 168 - (lines.length - 1) * lineHeight;
  const titleText = lines
    .map(
      (line, index) =>
        `<text x="64" y="${baseY + index * lineHeight}" font-family="Anton" font-size="${fontSize}" fill="#E8EBEF" letter-spacing="1">${escapeXml(line.toUpperCase())}</text>`,
    )
    .join("");

  const author = options.author ? ` · ${escapeXml(options.author)}` : "";
  const lockup =
    `<g class="logo-fg" fill="#E8EBEF"><rect x="56" y="28" width="26" height="52" rx="2"/>${WORDMARK_SHAPES}</g>` +
    `<g class="logo-accent" fill="${BRAND_CYAN}"><rect x="82" y="-24" width="26" height="52" rx="2"/></g>`;
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#07090B"/>
  <g opacity="0.5">${bars}</g>
  <g transform="translate(64 ${LOCKUP_TOP.toFixed(2)}) scale(${LOCKUP_SCALE.toFixed(4)}) translate(${-LOCKUP_BOX.x} ${-LOCKUP_BOX.y})">${lockup}</g>
  <text x="${WIDTH - 64}" y="${HEADER_BASELINE}" text-anchor="end" font-family="IBM Plex Mono" font-size="22" fill="#5C6673">COMPOSITION</text>
  ${titleText}
  <text x="64" y="${HEIGHT - 64}" font-family="IBM Plex Mono" font-size="24" fill="#A9B2BD" letter-spacing="3">MADE WITH JAZZ${author}</text>
</svg>`;

  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: WIDTH },
      font: { fontFiles: FONT_FILES, loadSystemFonts: false },
    });
    return resvg.render().asPng();
  } catch (error) {
    // The card is an enhancement, never a blocker for the publish itself.
    console.warn(`publish_composition: OG card render failed: ${String(error)}`);
    return Buffer.alloc(0);
  }
}

/**
 * Extract the composition's title for the OG card: the `<title>` text, with
 * trailing "— subtitle" / "– subtitle" segments stripped (the card carries
 * the title, not the separator noise).
 */
export function titleFromHtml(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = (match?.[1] ?? "").trim();
  title = title.replace(/\s*[—–-]\s*.*$/, "").trim();
  return title || "Untitled composition";
}

/**
 * Inject Open Graph meta tags into the published HTML (idempotent: a second
 * run replaces the previous tags). Returns the original HTML when there is
 * no <head> to inject into.
 */
export function injectOgMeta(html: string, title: string, ogImageUrl: string): string {
  // The marker comment brackets the block we manage, so re-publishing
  // replaces it in place no matter how often it has run.
  const pattern = /<!-- jazz:og -->[\s\S]*?<!-- \/jazz:og -->\n?/;
  const tags =
    "<!-- jazz:og -->\n" +
    `<meta property="og:type" content="website">\n` +
    `<meta property="og:title" content="${escapeXml(title)}">\n` +
    `<meta property="og:image" content="${escapeXml(ogImageUrl)}">\n` +
    `<meta name="twitter:card" content="summary_large_image">\n` +
    "<!-- /jazz:og -->";
  if (pattern.test(html)) {
    return html.replace(pattern, `${tags}\n`);
  }
  return html.replace(/<head[^>]*>/i, (head) => `${head}\n${tags}\n`);
}
