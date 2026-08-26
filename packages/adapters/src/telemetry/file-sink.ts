import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { TelemetryEvent } from "@jazz/core/interfaces/telemetry";
import type { TelemetryEventReader, TelemetrySink } from "./sink";

const EVENTS_DIR = "events";

/** Date partition for an event file name: YYYY-MM-DD. */
export function datePartition(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Appends events as NDJSON under `<storagePath>/events/YYYY-MM-DD.ndjson`.
 *
 * This is Jazz's default sink and the only one that can be read back.
 */
export class FileTelemetrySink implements TelemetrySink, TelemetryEventReader {
  readonly name = "file";
  private directoryCreated = false;

  constructor(
    private readonly storagePath: string,
    private readonly retentionDays: number,
  ) {}

  private get eventsDirectory(): string {
    return path.join(this.storagePath, EVENTS_DIR);
  }

  async write(events: readonly TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;

    if (!this.directoryCreated) {
      await mkdir(this.eventsDirectory, { recursive: true });
      this.directoryCreated = true;
    }

    const byPartition = new Map<string, TelemetryEvent[]>();
    for (const event of events) {
      const partition = datePartition(new Date(event.timestamp));
      const existing = byPartition.get(partition);
      if (existing) {
        existing.push(event);
      } else {
        byPartition.set(partition, [event]);
      }
    }

    for (const [partition, partitionEvents] of byPartition) {
      const filePath = path.join(this.eventsDirectory, `${partition}.ndjson`);
      const lines = partitionEvents.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await appendFile(filePath, lines, { encoding: "utf8" });
    }
  }

  async readAll(): Promise<TelemetryEvent[]> {
    let files: string[];
    try {
      files = await readdir(this.eventsDirectory);
    } catch {
      return [];
    }

    const events: TelemetryEvent[] = [];
    for (const file of files.filter((name) => name.endsWith(".ndjson")).sort()) {
      const content = await readFile(path.join(this.eventsDirectory, file), { encoding: "utf8" });
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          events.push(JSON.parse(line) as TelemetryEvent);
        } catch {
          // Skip malformed lines rather than failing the whole query.
        }
      }
    }
    return events;
  }

  /** Delete event files older than the retention window. Returns the count removed. */
  async prune(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cutoffPartition = datePartition(cutoff);

    let files: string[];
    try {
      files = await readdir(this.eventsDirectory);
    } catch {
      return 0;
    }

    let pruned = 0;
    for (const file of files) {
      if (!file.endsWith(".ndjson")) continue;
      if (file.replace(".ndjson", "") < cutoffPartition) {
        await unlink(path.join(this.eventsDirectory, file));
        pruned += 1;
      }
    }
    return pruned;
  }
}
