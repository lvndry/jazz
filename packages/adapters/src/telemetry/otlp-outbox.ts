/**
 * Bounded, private disk queue for OTLP requests.
 *
 * Entries contain already-mapped payloads, not raw Jazz events or HTTP headers.
 * A hash of the signal and destination keeps pending data tied to the endpoint
 * it was created for. Atomic rename makes each entry recoverable after a crash.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OtlpSignal } from "./otlp-config";

const ENTRY_PATTERN = /^[a-f0-9]{24}-\d{13}-\d{6}-[a-f0-9-]+\.json$/;
const CLAIM_PATTERN = /^\.claim-(\d+)-(\d{13})-([a-f0-9]{24}-\d{13}-\d{6}-[a-f0-9-]+\.json)$/;
const CLAIM_LEASE_MS = 24 * 60 * 60 * 1000;
let lastEntryTimestamp = 0;
let lastEntrySequence = 0;

function nextEntryOrder(): string {
  const now = Date.now();
  if (now > lastEntryTimestamp) {
    lastEntryTimestamp = now;
    lastEntrySequence = 0;
  } else if (lastEntrySequence < 999_999) {
    lastEntrySequence += 1;
  } else {
    lastEntryTimestamp += 1;
    lastEntrySequence = 0;
  }
  return `${String(lastEntryTimestamp).padStart(13, "0")}-${String(lastEntrySequence).padStart(6, "0")}`;
}

interface QueueEntry {
  readonly file: string;
  readonly originalFile: string;
  readonly claimed: boolean;
  readonly size: number;
  readonly createdAt: number;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A queued request is addressed by the signal and endpoint that created it. */
export class OtlpOutbox {
  private readonly directory: string;
  private readonly destinationKeys: Readonly<Record<OtlpSignal, string>>;

  constructor(
    storagePath: string,
    endpoints: Readonly<Record<OtlpSignal, string>>,
    private readonly maxBytes: number,
    private readonly maxAgeMs: number,
    private readonly onDropped: (
      count: number,
      reason: "capacity_or_age" | "permanent",
    ) => void = () => {},
  ) {
    this.directory = path.join(storagePath, "otlp-outbox");
    this.destinationKeys = Object.fromEntries(
      (Object.entries(endpoints) as [OtlpSignal, string][]).map(([signal, endpoint]) => [
        signal,
        createHash("sha256").update(`${signal}\0${endpoint}`).digest("hex").slice(0, 24),
      ]),
    ) as Record<OtlpSignal, string>;
  }

  /** Persist a mapped OTLP payload before making a network request. */
  async enqueue(signal: OtlpSignal, body: string): Promise<boolean> {
    const size = Buffer.byteLength(body);
    if (size > this.maxBytes) {
      this.onDropped(1, "capacity_or_age");
      return false;
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const name = `${this.destinationKeys[signal]}-${nextEntryOrder()}-${randomUUID()}.json`;
    const temporary = path.join(this.directory, `.${name}.tmp`);
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(this.directory, name));
    await this.prune();
    return (await this.entries()).some((entry) => entry.originalFile === name);
  }

  /** Deliver this destination's entries oldest first, retaining retryable failures. */
  async drain(
    signal: OtlpSignal,
    send: (body: string) => Promise<"accepted" | "rejected" | "retry">,
  ): Promise<void> {
    await this.prune();
    const prefix = `${this.destinationKeys[signal]}-`;
    for (const entry of await this.entries()) {
      if (entry.claimed || !entry.originalFile.startsWith(prefix)) continue;
      const ready = path.join(this.directory, entry.originalFile);
      const claim = path.join(
        this.directory,
        `.claim-${process.pid}-${String(Date.now()).padStart(13, "0")}-${entry.originalFile}`,
      );
      try {
        await rename(ready, claim);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      try {
        const body = await readFile(claim, "utf8");
        const outcome = await send(body);
        if (outcome === "retry") {
          await rename(claim, ready);
          break;
        }
        await unlink(claim);
        if (outcome === "rejected") this.onDropped(1, "permanent");
      } catch (error) {
        try {
          await rename(claim, ready);
        } catch (restoreError) {
          if (!missing(restoreError)) throw restoreError;
        }
        throw error;
      }
    }
  }

  /** Bound disk use across all signals and destinations, including stale ones. */
  private async prune(): Promise<void> {
    const entries = await this.entries();
    const now = Date.now();
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let dropped = 0;
    for (const entry of entries) {
      if (entry.claimed) continue;
      if (now - entry.createdAt <= this.maxAgeMs && bytes <= this.maxBytes) continue;
      try {
        await unlink(path.join(this.directory, entry.file));
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      bytes -= entry.size;
      dropped += 1;
    }
    if (dropped > 0) this.onDropped(dropped, "capacity_or_age");
  }

  private async entries(): Promise<QueueEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries = await Promise.all(
      names.map(async (file): Promise<QueueEntry | undefined> => {
        const claim = CLAIM_PATTERN.exec(file);
        if (!ENTRY_PATTERN.test(file) && !claim) return undefined;
        const originalFile = claim?.[3] ?? file;
        if (claim) {
          const claimedAt = Number(claim[2]);
          const pid = Number(claim[1]);
          if (Date.now() - claimedAt > CLAIM_LEASE_MS || !processAlive(pid)) {
            try {
              await rename(
                path.join(this.directory, file),
                path.join(this.directory, originalFile),
              );
              file = originalFile;
            } catch (error) {
              if (missing(error)) return undefined;
              throw error;
            }
          }
        }
        try {
          const info = await stat(path.join(this.directory, file));
          return {
            file,
            originalFile,
            claimed: file !== originalFile,
            size: info.size,
            createdAt: Number(originalFile.slice(25, 38)),
          };
        } catch (error) {
          if (missing(error)) return undefined;
          throw error;
        }
      }),
    );
    return entries
      .filter((entry): entry is QueueEntry => entry !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.file.localeCompare(b.file));
  }
}
