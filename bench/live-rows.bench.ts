// The live band recomputes its rows on every 6Hz tick with no memo (#397
// deliberately confined the tick to LiveZone; this keeps the recompute cheap
// enough to stay that way).
import { bench, report } from "./harness";
import { liveRows } from "../src/cli/ui/fullscreen/LiveZone";
import type { LiveModel } from "../src/cli/ui/fullscreen/types";

const VIEWPORT = { width: 120, height: 40 };

const busyModel: LiveModel = {
  tools: [
    { app: "files", operation: "read src/module.ts", elapsedMs: 4_000, phase: 0 },
    { app: "search", operation: "grep pattern across repo", elapsedMs: 2_000, phase: 1 },
    { app: "browser", operation: "load docs page", elapsedMs: 1_000, phase: 2 },
  ],
  hiddenTools: ["gmail", "calendar"],
  step: { index: 2, total: 5, label: "gathering context" },
  waiting: "reading the repository before it answers",
  elapsedMs: 12_000,
  reservedRows: 6,
};

const results = [
  bench("liveRows busy band, per tick", (iteration) => {
    liveRows(busyModel, VIEWPORT, false, undefined, 6, iteration);
  }),
];

report("live-rows", results);
