import { mkdtemp, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { FileTelemetrySink } from "./file-sink";

/** Retention must happen in ordinary writes, not only via an unused maintenance hook. */
describe("FileTelemetrySink retention", () => {
  it("removes expired date partitions when a new event arrives", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-telemetry-"));
    try {
      const eventsDirectory = path.join(directory, "events");
      await mkdir(eventsDirectory);
      await writeFile(path.join(eventsDirectory, "2020-01-01.ndjson"), "old\n");
      const sink = new FileTelemetrySink(directory, 90);
      await sink.write([
        { id: "new", type: "custom", timestamp: new Date().toISOString(), data: {} },
      ]);
      expect(await readdir(eventsDirectory)).toEqual([
        `${new Date().toISOString().slice(0, 10)}.ndjson`,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
