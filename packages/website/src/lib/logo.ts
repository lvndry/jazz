/**
 * The Jazz mark and wordmark — the one geometry every rendered logo is built from: the site
 * header, avatars, favicon, app icons, OG images and the README assets.
 *
 * The mark is one terminal cell (1:2) split into the ▞ quadrants: the on-beat block bottom-left
 * in the foreground colour, the off-beat block top-right in the accent. In the lockup the cell
 * spans the wordmark's full height, from the top of the j's dot to the foot of its descender,
 * the way a terminal cell holds a whole glyph.
 */

export const BRAND_INK = "#0B0D10";
export const BRAND_SNOW = "#F5F7FA";
export const BRAND_CYAN = "#00D7FF";
/** Cyan darkened to read on white; the light skin's `--jz-primary` family. */
export const BRAND_CYAN_DEEP = "#00718F";

export interface LogoPaint {
  readonly foreground: string;
  readonly accent: string;
}

export const MARK_VIEWBOX = "0 0 120 120";

/** The lockup's drawing box in its own units; the wordmark's baseline is at y = 60. */
export const LOCKUP_BOX = { x: 56, y: -24, width: 264, height: 104, baseline: 60 } as const;
export const LOCKUP_VIEWBOX = `${LOCKUP_BOX.x} ${LOCKUP_BOX.y} ${LOCKUP_BOX.width} ${LOCKUP_BOX.height}`;

const WORDMARK_SHAPES = [
  `<path d="M140 0 H152 V80 H124 V68 H140 Z"/>`,
  `<rect x="140" y="-24" width="12" height="12"/>`,
  `<path d="M164 0 H208 V60 H164 V24 H196 V12 H164 Z M176 36 V48 H196 V36 Z"/>`,
  `<path d="M220 0 H264 V12 L235 48 H264 V60 H220 V48 L249 12 H220 Z"/>`,
  `<path d="M276 0 H320 V12 L291 48 H320 V60 H276 V48 L305 12 H276 Z"/>`,
].join("");

/**
 * Shapes are grouped by role with `logo-fg` / `logo-accent` classes, so a page can repaint them
 * from CSS (which outranks the `fill` attributes) while standalone files keep their hex fills.
 */
export function markShapes(paint: LogoPaint): string {
  return (
    `<g class="logo-fg" fill="${paint.foreground}"><rect x="36" y="60" width="24" height="48" rx="2"/></g>` +
    `<g class="logo-accent" fill="${paint.accent}"><rect x="60" y="12" width="24" height="48" rx="2"/></g>`
  );
}

export function lockupShapes(paint: LogoPaint): string {
  return (
    `<g class="logo-fg" fill="${paint.foreground}"><rect x="56" y="28" width="26" height="52" rx="2"/>${WORDMARK_SHAPES}</g>` +
    `<g class="logo-accent" fill="${paint.accent}"><rect x="82" y="-24" width="26" height="52" rx="2"/></g>`
  );
}

/**
 * The app icon: the mark on an ink tile. `rounded: false` gives a full-bleed square for
 * platforms that apply their own mask (iOS home screen).
 */
export function iconSvg(
  options: { readonly size?: number; readonly rounded?: boolean } = {},
): string {
  const size = options.size ?? 120;
  const radius = options.rounded === false ? 0 : 26;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${MARK_VIEWBOX}">` +
    `<rect width="120" height="120" rx="${radius}" fill="${BRAND_INK}"/>` +
    markShapes({ foreground: BRAND_SNOW, accent: BRAND_CYAN }) +
    `</svg>`
  );
}

export function lockupSvg(paint: LogoPaint): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOCKUP_VIEWBOX}" role="img" aria-label="Jazz">` +
    lockupShapes(paint) +
    `</svg>`
  );
}
