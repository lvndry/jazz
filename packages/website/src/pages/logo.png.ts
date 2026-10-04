import { renderIconPng } from "../lib/og";

/** Raster logo for the Organization JSON-LD, which search engines want as a bitmap of at least 112px. */
const LOGO_SIZE = 512;

export function GET(): Response {
  const png = renderIconPng(LOGO_SIZE);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
}
