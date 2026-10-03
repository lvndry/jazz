/**
 * A pending wait, as the transcript blocks that replace the conversation while the user is
 * looking at it: a heading, then the wait's report, whose checks run oldest first so the newest
 * lands at the live edge. Pure, like the sub-agent view.
 */

import { getGlyphs } from "../glyphs";
import type { Block } from "./types";
import {
  describeBackgroundTiming,
  waitReport,
  type BackgroundItem,
} from "../models/background-work";

export function waitBlocks(item: BackgroundItem, now: number): Block[] {
  const heading = [item.description, "watching", describeBackgroundTiming(item, now)].join(
    ` ${getGlyphs().bullet} `,
  );
  return [
    { id: `${item.batchId}:heading`, seq: 0, kind: "divider", label: heading },
    { id: `${item.batchId}:checks`, seq: 1, kind: "report", report: waitReport(item, now) },
  ];
}

/** Only a wait has checks to show; a queued job's row offers cancelling alone. */
export function opensWaitView(item: BackgroundItem | undefined): item is BackgroundItem {
  return item?.kind === "watch";
}

/** Footer hints while the cursor is on a row of the waits list. */
export function waitRowHints(item: BackgroundItem | undefined): readonly string[] {
  return opensWaitView(item)
    ? ["up down to choose", "enter to open", "x to cancel", "esc to close"]
    : ["up down to choose", "x to cancel", "esc to close"];
}
