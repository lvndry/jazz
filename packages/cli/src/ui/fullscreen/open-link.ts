import { openBrowser } from "@jazz/adapters/oauth/loopback";
import { terminalCellWidth } from "../text/terminal-cells";

const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Link targets come from model output, so a click only ever hands the browser a
 * web or mail address — never a local file or an app-registered scheme.
 */
export function isOpenableLink(target: string): boolean {
  try {
    return OPENABLE_PROTOCOLS.has(new URL(target).protocol);
  } catch {
    return false;
  }
}

/** The link target under `column`, counted in terminal cells from the row's first span. */
export function linkAtColumn(
  segments: readonly { readonly text: string; readonly link?: string }[],
  column: number,
): string | undefined {
  if (column < 0) {
    return undefined;
  }
  let start = 0;
  for (const segment of segments) {
    const end = start + terminalCellWidth(segment.text);
    if (column < end) {
      return segment.link;
    }
    start = end;
  }
  return undefined;
}

export function openLink(target: string): void {
  if (!isOpenableLink(target)) {
    return;
  }
  openBrowser(target, OPENABLE_PROTOCOLS);
}
