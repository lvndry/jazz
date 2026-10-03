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
