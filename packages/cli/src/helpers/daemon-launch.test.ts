import { describe, expect, it } from "bun:test";
import {
  backgroundDaemonSpawnOptions,
  describeDaemonStart,
  unsupervisedDaemonNote,
} from "./daemon-launch";

describe("describeDaemonStart", () => {
  it("says the work started only when a daemon for this home is on it", () => {
    expect(describeDaemonStart("Goal g1", { kind: "running" }, true)).toContain(
      "daemon is working on it",
    );
    expect(describeDaemonStart("Goal g1", { kind: "started", pid: 42 }, true)).toContain("pid 42");
    expect(describeDaemonStart("Goal g1", { kind: "port-taken", port: 4747 }, true)).toContain(
      "not serving this Jazz home",
    );
    expect(describeDaemonStart("Goal g1", { kind: "unavailable" }, true)).toContain(
      "run `jazz daemon`",
    );
  });

  it("warns, and points at daemon install, when no supervisor restarts the daemon", () => {
    const unsupervised = describeDaemonStart("Goal g1", { kind: "started", pid: 42 }, false);
    expect(unsupervised).toContain("No supervised daemon is installed");
    expect(unsupervised).toContain("sudo jazz daemon install");
    expect(describeDaemonStart("Goal g1", { kind: "running" }, true)).not.toContain("supervised");
  });

  it("says nothing about supervision when the port belongs to another home", () => {
    expect(describeDaemonStart("Goal g1", { kind: "port-taken", port: 4747 }, false)).not.toContain(
      "supervised",
    );
  });
});

describe("unsupervisedDaemonNote", () => {
  it("is empty for a supervised daemon", () => {
    expect(unsupervisedDaemonNote(true)).toBeUndefined();
    expect(unsupervisedDaemonNote(false)).toContain("jazz daemon install");
  });
});

describe("background daemon spawn", () => {
  it("starts in a session of its own, with no controlling terminal", () => {
    const options = backgroundDaemonSpawnOptions(["jazz", "daemon", "--foreground"], 7);
    expect(options).toMatchObject({ detached: true, stdin: "ignore", stdout: 7, stderr: 7 });
  });
});
