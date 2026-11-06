import * as fs from "node:fs";
import * as os from "node:os";
import { hostname } from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "@jazz/core/utils/file-lock";
import { afterEach, beforeEach, describe, expect, test, mock, spyOn } from "bun:test";
import { SweepDirectory } from "./sweep-directory";
import {
  openConversationKey,
  resetToolResultSweepSchedule,
  scheduleToolResultSweep,
  sweepOrphanedToolResults,
  sweepToolResultsIfDue,
  TOOL_RESULT_SWEEP_INTERVAL_MS,
} from "./tool-result-retention";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

let home: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-retention-")));
  resetToolResultSweepSchedule();
});

afterEach(() => {
  mock.restore();
  resetToolResultSweepSchedule();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeResult(conversation: string, name: string, ageMs: number): string {
  const target = path.join(home, "work", "agent", conversation, "tool-results", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "body");
  const modifiedAt = new Date(NOW - ageMs);
  fs.utimesSync(target, modifiedAt, modifiedAt);
  return target;
}

function touchLog(conversation: string, ageMs: number): void {
  const target = path.join(home, "history", "conversations", "agent", `${conversation}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{}");
  const modifiedAt = new Date(NOW - ageMs);
  fs.utimesSync(target, modifiedAt, modifiedAt);
}

describe("sweepOrphanedToolResults", () => {
  test("deletes old results of an abandoned conversation and prunes its empty directories", async () => {
    const old = writeResult("abandoned", "call_1.txt", 60 * DAY_MS);
    touchLog("abandoned", 60 * DAY_MS);
    const result = await sweepOrphanedToolResults({ jazzHome: home, now: NOW, retentionDays: 30 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(home, "work", "agent"))).toBe(false);
    expect(result.sweep.deletedFiles).toBe(1);
  });

  for (const level of ["work", "agent", "conversation", "tool-results"] as const) {
    test(`refuses a symlink at the ${level} boundary`, async () => {
      const old = writeResult("abandoned", "old.txt", 60 * DAY_MS);
      const directories = {
        work: path.join(home, "work"),
        agent: path.join(home, "work", "agent"),
        conversation: path.join(home, "work", "agent", "abandoned"),
        "tool-results": path.dirname(old),
      };
      const moved = path.join(home, `outside-${level}`);
      fs.renameSync(directories[level], moved);
      fs.symlinkSync(moved, directories[level]);
      await sweepOrphanedToolResults({ jazzHome: home, now: NOW, retentionDays: 30 });
      expect(fs.existsSync(old)).toBe(true);
    });
  }

  test("counts empty conversation discovery against the shared entry budget", async () => {
    for (let index = 0; index < 50; index++) {
      fs.mkdirSync(path.join(home, "work", "agent", `empty-${index}`), { recursive: true });
    }
    const result = await sweepOrphanedToolResults({
      jazzHome: home,
      now: NOW,
      retentionDays: 30,
      maxEntries: 4,
    });
    expect(result.sweep.examined).toBe(4);
    expect(result.sweep.truncated).toBe(true);
    expect(result.conversationsVisited).toBeLessThanOrEqual(3);
  });

  test("does not prune an empty agent directory it did not empty", async () => {
    writeResult("abandoned", "old.txt", 60 * DAY_MS);
    const untouched = path.join(home, "work", "z-empty");
    fs.mkdirSync(untouched);
    const original = SweepDirectory.prototype.entries;
    spyOn(SweepDirectory.prototype, "entries").mockImplementation(function* (this: SweepDirectory) {
      yield* [...original.call(this)].sort();
    });
    await sweepOrphanedToolResults({ jazzHome: home, now: NOW, retentionDays: 30 });
    expect(fs.existsSync(untouched)).toBe(true);
  });

  test("never touches journal.jsonl", async () => {
    writeResult("abandoned", "call_1.txt", 60 * DAY_MS);
    const journal = path.join(home, "work", "agent", "abandoned", "journal.jsonl");
    fs.writeFileSync(journal, "{}");
    const old = new Date(NOW - 60 * DAY_MS);
    fs.utimesSync(journal, old, old);
    await sweepOrphanedToolResults({ jazzHome: home, now: NOW, retentionDays: 30 });
    expect(fs.existsSync(journal)).toBe(true);
  });

  test("retention 0 disables the sweep", async () => {
    const old = writeResult("abandoned", "call_1.txt", 600 * DAY_MS);
    const result = await sweepOrphanedToolResults({ jazzHome: home, now: NOW, retentionDays: 0 });
    expect(result.skipped).toBe("disabled");
    expect(fs.existsSync(old)).toBe(true);
  });

  test("skips a conversation holding the turn lease", async () => {
    const old = writeResult("busy", "call_1.txt", 60 * DAY_MS);
    fs.mkdirSync(path.join(home, "history", "conversation-locks", "agent", "busy.turn"), {
      recursive: true,
    });
    const result = await sweepOrphanedToolResults({ jazzHome: home, now: NOW, retentionDays: 30 });
    expect(fs.existsSync(old)).toBe(true);
    expect(result.conversationsProtected).toBe(1);
  });

  test("protects an idle chat attachment held by another live process", async () => {
    const old = writeResult("open", "old.txt", 60 * DAY_MS);
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const marker = path.join(home, "chat-attachments", "agent", "open.json");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ pid: child.pid, host: hostname() }));
      const result = await sweepOrphanedToolResults({
        jazzHome: home,
        now: NOW,
        retentionDays: 30,
      });
      expect(fs.existsSync(old)).toBe(true);
      expect(result.conversationsProtected).toBe(1);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test.skipIf(process.getuid?.() !== 0)(
    "preserves a sandbox owner's access to newly created lease directories",
    async () => {
      for (let index = 0; index < 70; index++) {
        writeResult("owned", `old-${index}`, 60 * DAY_MS);
      }
      fs.chownSync(home, 12002, 12002);
      let checked = false;
      await sweepOrphanedToolResults({
        jazzHome: home,
        now: NOW,
        retentionDays: 30,
        yieldToEventLoop: async () => {
          checked = true;
          const lock = path.join(home, "history", "conversation-locks", "agent", "owned.turn");
          expect(fs.statSync(lock).uid).toBe(12002);
          expect(fs.statSync(path.join(lock, "owner.json")).uid).toBe(12002);
        },
      });
      expect(checked).toBe(true);
      expect(fs.statSync(path.join(home, "history")).uid).toBe(12002);
    },
  );

  test("holds the normal turn lease across event-loop yields and releases it afterwards", async () => {
    for (let index = 0; index < 70; index++) {
      writeResult("busy-race", `old-${index}`, 60 * DAY_MS);
    }
    const lock = path.join(home, "history", "conversation-locks", "agent", "busy-race.turn");
    let checked = false;
    await sweepOrphanedToolResults({
      jazzHome: home,
      now: NOW,
      retentionDays: 30,
      yieldToEventLoop: async () => {
        if (checked) {
          return;
        }
        checked = true;
        await expect(acquireFileLock(lock, { maxWaitMs: 0 })).rejects.toThrow("Timed out");
      },
    });
    expect(checked).toBe(true);
    const release = await acquireFileLock(lock, { maxWaitMs: 0 });
    await release();
  });

  test("skips a conversation open in this process", async () => {
    const old = writeResult("open", "call_1.txt", 60 * DAY_MS);
    await sweepOrphanedToolResults({
      jazzHome: home,
      now: NOW,
      retentionDays: 30,
      openConversations: new Set([openConversationKey("agent", "open")]),
    });
    expect(fs.existsSync(old)).toBe(true);
  });

  test("skips a conversation whose log was written within the window", async () => {
    const old = writeResult("recent", "call_1.txt", 60 * DAY_MS);
    touchLog("recent", 2 * DAY_MS);
    await sweepOrphanedToolResults({ jazzHome: home, now: NOW, retentionDays: 30 });
    expect(fs.existsSync(old)).toBe(true);
  });

  test("honors the shared entry bound across conversations", async () => {
    for (let index = 0; index < 5; index += 1) {
      writeResult(`conv-${String(index)}`, "call_1.txt", 60 * DAY_MS);
    }
    const result = await sweepOrphanedToolResults({
      jazzHome: home,
      now: NOW,
      retentionDays: 30,
      maxEntries: 2,
    });
    expect(result.sweep.examined).toBeLessThanOrEqual(2);
    expect(result.sweep.truncated).toBe(true);
  });
});

describe("sweepToolResultsIfDue", () => {
  test("runs once, then not again within the interval, then again after it", async () => {
    const first = writeResult("abandoned", "call_1.txt", 60 * DAY_MS);
    const firstRun = await sweepToolResultsIfDue({ jazzHome: home, now: NOW, retentionDays: 30 });
    expect(firstRun).toBeDefined();
    expect(fs.existsSync(first)).toBe(false);

    const second = writeResult("abandoned", "call_2.txt", 60 * DAY_MS);
    const soon = NOW + TOOL_RESULT_SWEEP_INTERVAL_MS - 1;
    const tooSoon = await sweepToolResultsIfDue({ jazzHome: home, now: soon, retentionDays: 30 });
    expect(tooSoon).toBeUndefined();
    expect(fs.existsSync(second)).toBe(true);

    const later = NOW + TOOL_RESULT_SWEEP_INTERVAL_MS + 1;
    const dueAgain = await sweepToolResultsIfDue({ jazzHome: home, now: later, retentionDays: 30 });
    expect(dueAgain).toBeDefined();
    expect(fs.existsSync(second)).toBe(false);
  });

  for (const operation of ["readdir", "unlink"] as const) {
    test(`retries immediately after a failed ${operation}, without stamping success`, async () => {
      const old = writeResult("abandoned", "old.txt", 60 * DAY_MS);
      const options = { jazzHome: home, now: NOW, retentionDays: 30 };
      const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
      const originalRemove = SweepDirectory.prototype.remove;
      const injected =
        operation === "readdir"
          ? spyOn(SweepDirectory.prototype, "entries").mockImplementation(() => {
              throw failure;
            })
          : spyOn(SweepDirectory.prototype, "remove").mockImplementation(function (
              this: SweepDirectory,
              name,
              directory,
            ) {
              if (name === "old.txt") {
                throw failure;
              }
              return originalRemove.call(this, name, directory);
            });
      const failed = await sweepToolResultsIfDue(options);
      injected.mockRestore();
      expect(failed?.sweep.failures).toHaveLength(1);
      expect(fs.existsSync(path.join(home, "work", ".tool-results-swept-at"))).toBe(false);
      const retried = await sweepToolResultsIfDue(options);
      expect(retried?.sweep.deletedFiles).toBe(1);
      expect(fs.existsSync(old)).toBe(false);
    });
  }

  for (const link of ["symlink", "hardlink"] as const) {
    test(`replaces a ${link} stamp without writing to its target`, async () => {
      writeResult("abandoned", "old.txt", 60 * DAY_MS);
      const target = path.join(home, "keep-stamp.txt");
      fs.writeFileSync(target, "outside");
      fs.utimesSync(target, new Date(0), new Date(0));
      const stamp = path.join(home, "work", ".tool-results-swept-at");
      if (link === "symlink") {
        fs.symlinkSync(target, stamp);
      } else {
        fs.linkSync(target, stamp);
      }
      await sweepToolResultsIfDue({ jazzHome: home, now: NOW, retentionDays: 30 });
      expect(fs.readFileSync(target, "utf8")).toBe("outside");
      expect(fs.statSync(target).mtimeMs).toBe(0);
      expect(fs.lstatSync(stamp).isDirectory()).toBe(true);
      expect(fs.statSync(stamp).mode & 0o777).toBe(0o700);
    });
  }

  test("retention 0 neither sweeps nor writes a stamp", async () => {
    const outcome = await sweepToolResultsIfDue({ jazzHome: home, now: NOW, retentionDays: 0 });
    expect(outcome).toBeUndefined();
    expect(fs.existsSync(path.join(home, "work"))).toBe(false);
  });
});

describe("scheduleToolResultSweep", () => {
  test("discovers homes created after the first sweep", async () => {
    const homes = [home];
    let first: (() => void) | undefined;
    let second: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      first = resolve;
    });
    const secondRead = new Promise<void>((resolve) => {
      second = resolve;
    });
    scheduleToolResultSweep({
      jazzHomes: () => {
        if (homes.length === 1) {
          first?.();
        } else {
          second?.();
        }
        return [...homes];
      },
      retentionDays: () => 30,
      startupDelayMs: 0,
      repeatEveryMs: 1,
    });
    await firstRead;
    homes.push(path.join(home, "new-sandbox"));
    await secondRead;
    expect(homes).toHaveLength(2);
  });

  test("does not enumerate homes when retention is disabled", async () => {
    let reads = 0;
    let ready: () => void = () => undefined;
    const configured = new Promise<void>((resolve) => {
      ready = resolve;
    });
    scheduleToolResultSweep({
      jazzHomes: () => {
        reads++;
        return [];
      },
      retentionDays: () => {
        ready();
        return 0;
      },
      startupDelayMs: 0,
    });
    await configured;
    await Promise.resolve();
    expect(reads).toBe(0);
  });

  test("shares a bounded budget across streamed homes and reads policy once", async () => {
    let reads = 0;
    let discovered = 0;
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    scheduleToolResultSweep({
      jazzHomes: function* () {
        try {
          for (let index = 0; index < 100; index++) {
            discovered++;
            yield path.join(home, `absent-${index}`);
          }
        } finally {
          done();
        }
      },
      retentionDays: () => {
        reads++;
        return 30;
      },
      maxEntriesPerRun: 3,
      startupDelayMs: 0,
    });
    await finished;
    expect(reads).toBe(1);
    expect(discovered).toBeLessThanOrEqual(4);
  });

  test("schedules once per process", () => {
    const options = { jazzHomes: () => [home], retentionDays: () => 30, startupDelayMs: 60_000 };
    expect(scheduleToolResultSweep(options)).toBe(true);
    expect(scheduleToolResultSweep(options)).toBe(false);
  });
});
