/** Standalone-build smoke: embedded native source, exclusive lease publication and deletion. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepOrphanedToolResults } from "./tool-result-retention";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-native-smoke-")));
try {
  const resultPath = path.join(home, "work", "agent", "conversation", "tool-results", "old.txt");
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, "old output");
  fs.utimesSync(resultPath, 0, 0);
  const result = await sweepOrphanedToolResults({
    jazzHome: home,
    retentionDays: 30,
    now: Date.now(),
  });
  assert.deepEqual(result.sweep.failures, []);
  assert.equal(result.sweep.deletedFiles, 1);
  assert.equal(fs.existsSync(resultPath), false);
  console.log("native retention smoke passed");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
