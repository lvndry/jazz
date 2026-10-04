import { renderIconPng } from "../lib/og";

/** iOS masks home-screen icons itself, so the tile is full-bleed. */
const APPLE_TOUCH_ICON_SIZE = 180;

export function GET(): Response {
  const png = renderIconPng(APPLE_TOUCH_ICON_SIZE, { rounded: false });
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
}
