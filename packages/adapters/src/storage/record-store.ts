/**
 * Versioned JSON records, one file per id, for controller-owned state (goals, loops).
 *
 * Each record is an atomic, fsynced JSON file with mode 0600 under a mode 0700 directory. Every
 * change is a compare-and-set against the version the caller read, taken under a per-record
 * cross-process lock, so two writers cannot both advance the same version. What a record may
 * become is the kind's decision (`nextRecord`); what every kind shares — the same id, the same
 * creation time, a version that moves by exactly one — is enforced here. Reading a record by id
 * fails loudly on corruption, so a damaged record is never mistaken for an absent one, while a
 * listing reports and skips it so one bad file cannot hide all the others.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { toError } from "@jazz/core/utils/storage";
import { writeJsonFileDurably } from "./durable-file";
import { withFileLock } from "./file-lock";

export interface VersionedRecord {
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RecordInput<Rec extends VersionedRecord> = Omit<Rec, "version">;

/** What a store needs to know about one kind of record. */
export interface RecordKind<Rec extends VersionedRecord> {
  /** "goal", "loop": used in errors and in the corrupt-file report. */
  readonly noun: string;
  readonly idOf: (record: RecordInput<Rec>) => string;
  readonly isId: (value: string) => boolean;
  readonly parse: (value: unknown) => { ok: true; record: Rec } | { ok: false; error: string };
  /**
   * The record an update produces, or a thrown refusal. Called after the shared checks, with
   * the stored record, the caller's proposed next one, and the version and time to stamp.
   */
  readonly nextRecord: (current: Rec, next: RecordInput<Rec>, stamped: StampedUpdate) => Rec;
}

export interface StampedUpdate {
  readonly version: number;
  readonly updatedAt: string;
}

/**
 * Called around each write with the record about to be stored, a way to read every other
 * record, and a store-wide lock to hold while checking them, so a kind can enforce a rule
 * across records (one active goal per conversation).
 */
export type WriteGuard<Rec extends VersionedRecord> = (
  record: Rec,
  write: () => Promise<void>,
  others: () => Promise<readonly Rec[]>,
  exclusive: <A>(name: string, operation: () => Promise<A>) => Promise<A>,
) => Promise<void>;

const runDirectly = <A>(_name: string, operation: () => Promise<A>): Promise<A> => operation();

function checkId<Rec extends VersionedRecord>(kind: RecordKind<Rec>, id: string): void {
  if (!kind.isId(id)) {
    throw new Error(`"${id}" is not a usable ${kind.noun} id.`);
  }
}

function assertValid<Rec extends VersionedRecord>(kind: RecordKind<Rec>, record: Rec): void {
  const parsed = kind.parse(record);
  if (!parsed.ok) {
    throw new Error(
      `${capitalized(kind.noun)} record "${kind.idOf(record)}" is invalid: ${parsed.error}`,
    );
  }
}

function capitalized(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

/** The shared rules for replacing `current` with `next`, then the kind's own. */
export function updatedRecord<Rec extends VersionedRecord>(
  kind: RecordKind<Rec>,
  current: Rec,
  expectedVersion: number,
  next: RecordInput<Rec>,
  now: Date,
): Rec {
  const id = kind.idOf(current);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error(`Expected ${kind.noun} version must be a positive safe integer.`);
  }
  checkId(kind, kind.idOf(next));
  if (current.version !== expectedVersion) {
    throw new Error(
      `${capitalized(kind.noun)} "${id}" changed: expected version ${expectedVersion}, found ${current.version}.`,
    );
  }
  if (kind.idOf(next) !== id) {
    throw new Error(`A ${kind.noun} update cannot change its id.`);
  }
  if (current.version === Number.MAX_SAFE_INTEGER) {
    throw new Error(`${capitalized(kind.noun)} "${id}" has exhausted its version counter.`);
  }
  if (next.createdAt !== current.createdAt) {
    throw new Error(`A ${kind.noun} update cannot change its creation time.`);
  }
  const updated = kind.nextRecord(current, next, {
    version: expectedVersion + 1,
    updatedAt: now.toISOString(),
  });
  assertValid(kind, updated);
  return updated;
}

const passThrough: WriteGuard<VersionedRecord> = (_record, write) => write();

/** In-memory records with the same create and compare-and-set semantics, for tests. */
export class InMemoryRecords<Rec extends VersionedRecord> {
  private readonly records = new Map<string, Rec>();

  constructor(
    private readonly kind: RecordKind<Rec>,
    private readonly guard: WriteGuard<Rec> = passThrough,
  ) {}

  private others(id: string): Promise<readonly Rec[]> {
    return Promise.resolve(
      [...this.records.values()].filter((record) => this.kind.idOf(record) !== id),
    );
  }

  async create(input: RecordInput<Rec>): Promise<Rec> {
    const id = this.kind.idOf(input);
    checkId(this.kind, id);
    if (this.records.has(id)) {
      throw new Error(`${capitalized(this.kind.noun)} "${id}" already exists.`);
    }
    const record = { ...structuredClone(input), version: 1 } as Rec;
    assertValid(this.kind, record);
    await this.guard(
      record,
      () => {
        this.records.set(id, record);
        return Promise.resolve();
      },
      () => this.others(id),
      runDirectly,
    );
    return structuredClone(record);
  }

  get(id: string): Rec | undefined {
    const record = this.kind.isId(id) ? this.records.get(id) : undefined;
    return record === undefined ? undefined : structuredClone(record);
  }

  all(): Rec[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async compareAndSet(id: string, expectedVersion: number, next: RecordInput<Rec>): Promise<Rec> {
    checkId(this.kind, id);
    const current = this.records.get(id);
    if (current === undefined) {
      throw new Error(`No ${this.kind.noun} with id "${id}".`);
    }
    const updated = updatedRecord(this.kind, current, expectedVersion, next, new Date());
    await this.guard(
      updated,
      () => {
        this.records.set(id, updated);
        return Promise.resolve();
      },
      () => this.others(id),
      runDirectly,
    );
    return structuredClone(updated);
  }
}

/** File-backed records: one `<id>.json` per record in `directory`. */
export class FileRecords<Rec extends VersionedRecord> {
  constructor(
    private readonly kind: RecordKind<Rec>,
    private readonly directory: string,
    private readonly guard: WriteGuard<Rec> = passThrough,
  ) {}

  private pathFor(id: string): string {
    checkId(this.kind, id);
    return path.join(this.directory, `${id}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    await nodeFs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await nodeFs.chmod(this.directory, 0o700);
  }

  private async withLock<A>(id: string, operation: () => Promise<A>): Promise<A> {
    await this.ensureDirectory();
    return withFileLock(`${this.pathFor(id)}.lock`, operation);
  }

  async read(id: string): Promise<Rec | undefined> {
    let raw: string;
    try {
      raw = await nodeFs.readFile(this.pathFor(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    const parsed = this.kind.parse(JSON.parse(raw) as unknown);
    if (!parsed.ok) {
      throw new Error(
        `${capitalized(this.kind.noun)} record "${id}" is invalid or corrupt: ${parsed.error}`,
      );
    }
    if (this.kind.idOf(parsed.record) !== id) {
      throw new Error(
        `${capitalized(this.kind.noun)} record "${id}" holds ${this.kind.noun} "${this.kind.idOf(parsed.record)}".`,
      );
    }
    return parsed.record;
  }

  /** Every readable record, reporting and skipping any corrupt file. */
  async all(): Promise<Rec[]> {
    let entries: readonly string[];
    try {
      entries = await nodeFs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const records: Rec[] = [];
    for (const entry of entries) {
      const id = entry.endsWith(".json") ? entry.slice(0, -".json".length) : undefined;
      if (id === undefined || !this.kind.isId(id)) {
        continue;
      }
      try {
        const record = await this.read(id);
        if (record !== undefined) {
          records.push(record);
        }
      } catch (error) {
        console.error(
          `[${this.kind.noun}s] Skipping ${this.kind.noun} "${id}": ${toError(error).message}`,
        );
      }
    }
    return records;
  }

  private write(id: string, record: Rec): Promise<void> {
    return this.guard(
      record,
      () => writeJsonFileDurably(this.pathFor(id), record),
      async () => (await this.all()).filter((other) => this.kind.idOf(other) !== id),
      (name, operation) => withFileLock(path.join(this.directory, `.${name}.lock`), operation),
    );
  }

  create(input: RecordInput<Rec>): Promise<Rec> {
    const id = this.kind.idOf(input);
    checkId(this.kind, id);
    return this.withLock(id, async () => {
      if ((await this.read(id)) !== undefined) {
        throw new Error(`${capitalized(this.kind.noun)} "${id}" already exists.`);
      }
      const record = { ...structuredClone(input), version: 1 } as Rec;
      assertValid(this.kind, record);
      await this.write(id, record);
      return structuredClone(record);
    });
  }

  compareAndSet(id: string, expectedVersion: number, next: RecordInput<Rec>): Promise<Rec> {
    checkId(this.kind, id);
    return this.withLock(id, async () => {
      const current = await this.read(id);
      if (current === undefined) {
        throw new Error(`No ${this.kind.noun} with id "${id}".`);
      }
      const updated = updatedRecord(this.kind, current, expectedVersion, next, new Date());
      await this.write(id, updated);
      return structuredClone(updated);
    });
  }
}
