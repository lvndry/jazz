import { describe, expect, test } from "bun:test";
import type { ConfinementStatus } from "./backend";
import { planLaunch, resolveConfinementMode, summarizeConfinement } from "./confine";

const policy = { roots: ["/work/project"] };
const argv = ["sh", "-c", "touch x"];

const seatbelt: ConfinementStatus = { level: "full", backend: "seatbelt" };
const unavailable: ConfinementStatus = {
  level: "none",
  backend: "none",
  reason: "bubblewrap (`bwrap`) is not installed",
  remedy: "Install bubblewrap or set `shell.confinement` to `off`.",
};

describe("resolveConfinementMode", () => {
  test("an explicit setting wins in both directions", () => {
    expect(resolveConfinementMode("off", false)).toBe("off");
    expect(resolveConfinementMode("on", true)).toBe("on");
  });

  test("defaults off when a person is attending and on otherwise", () => {
    expect(resolveConfinementMode(undefined, true)).toBe("off");
    expect(resolveConfinementMode(undefined, false)).toBe("on");
  });
});

describe("planLaunch", () => {
  test("off never wraps, whatever the backend", () => {
    expect(planLaunch({ mode: "off", policy, argv, status: seatbelt })).toEqual({
      kind: "unconfined",
    });
    expect(planLaunch({ mode: "off", policy, argv, status: unavailable })).toEqual({
      kind: "unconfined",
    });
  });

  test("on with seatbelt wraps in sandbox-exec and reports the level", () => {
    const plan = planLaunch({ mode: "on", policy, argv, status: seatbelt });
    expect(plan.kind).toBe("confined");
    if (plan.kind === "confined") {
      expect(plan.argv[0]).toBe("/usr/bin/sandbox-exec");
      expect(plan.argv.slice(-3)).toEqual(argv);
      expect(plan.level).toBe("full");
    }
  });

  test("on with bwrap wraps in bwrap and drops roots that do not exist", () => {
    const plan = planLaunch({
      mode: "on",
      policy: { roots: ["/", "/definitely/not/a/root"] },
      argv,
      status: { level: "partial", backend: "bwrap", bwrapPath: "/usr/bin/bwrap", devices: "host" },
    });
    expect(plan.kind).toBe("confined");
    if (plan.kind === "confined") {
      expect(plan.argv.join(" ")).toContain("--bind / /");
      expect(plan.argv.join(" ")).not.toContain("/definitely/not/a/root");
      expect(plan.level).toBe("partial");
    }
  });

  test("on without a backend fails closed with the reason and the remedy", () => {
    const plan = planLaunch({ mode: "on", policy, argv, status: unavailable });
    expect(plan.kind).toBe("refused");
    if (plan.kind === "refused") {
      expect(plan.message).toContain("not installed");
      expect(plan.message).toContain("The command was not run.");
      expect(plan.message).toContain("shell.confinement");
    }
  });

  test("never returns an unconfined plan for a bwrap status missing its binary path", () => {
    const plan = planLaunch({
      mode: "on",
      policy,
      argv,
      status: { level: "full", backend: "bwrap" },
    });
    expect(plan.kind).toBe("refused");
  });
});

describe("summarizeConfinement", () => {
  test("names the backend when full", () => {
    expect(summarizeConfinement(seatbelt)).toContain("seatbelt");
  });

  test("states the gap when partial", () => {
    expect(
      summarizeConfinement({ level: "partial", backend: "bwrap", reason: "device nodes writable" }),
    ).toContain("device nodes writable");
  });

  test("says commands are refused when unavailable", () => {
    expect(summarizeConfinement(unavailable)).toContain("refused");
  });
});
