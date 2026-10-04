import { iconSvg } from "../lib/logo";

export function GET(): Response {
  return new Response(iconSvg(), { headers: { "Content-Type": "image/svg+xml" } });
}
