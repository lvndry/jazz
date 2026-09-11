import { describe, expect, test } from "bun:test";
import { type GrantTarget, IMSG_INSTALL_COMMAND, planInstall, terminalAppName } from "./install";

const IN_GHOSTTY: GrantTarget = { kind: "launcher", label: "Ghostty", path: undefined };
const UNDER_LAUNCHD: GrantTarget = { kind: "self", label: "Jazz", path: "/usr/local/bin/jazz" };

const AT_A_TERMINAL = {
  interactive: true,
  homebrewPresent: true,
  grant: IN_GHOSTTY,
};

describe("planInstall", () => {
  test("proceeds when imsg already works", () => {
    expect(planInstall({ available: true }, AT_A_TERMINAL).action).toBe("proceed");
  });

  test("offers to install when it is merely missing and someone can answer", () => {
    const plan = planInstall(
      { available: false, kind: "missing", reason: "`imsg` is not installed." },
      AT_A_TERMINAL,
    );
    expect(plan.action).toBe("offer");
    expect(plan.action !== "proceed" && plan.message).toContain(IMSG_INSTALL_COMMAND);
  });

  test("never offers an install for a permission problem, which installing cannot fix", () => {
    const plan = planInstall(
      { available: false, kind: "denied", reason: "authorization denied" },
      AT_A_TERMINAL,
    );
    expect(plan.action).not.toBe("offer");
    expect(plan.action !== "proceed" && plan.message).toContain("Full Disk Access");
  });

  test("names the terminal, which is what macOS holds responsible for a run from one", () => {
    const plan = planInstall(
      { available: false, kind: "denied", reason: "authorization denied" },
      AT_A_TERMINAL,
    );
    expect(plan.action).toBe("grant");
    expect(plan.action === "grant" && plan.grant.label).toBe("Ghostty");
    expect(plan.action !== "proceed" && plan.message).toContain("Ghostty");
  });

  test("does not tell a terminal user to add the Jazz binary, which would do nothing", () => {
    const plan = planInstall(
      { available: false, kind: "denied", reason: "authorization denied" },
      AT_A_TERMINAL,
    );
    expect(plan.action === "grant" && plan.grant.path).toBeUndefined();
    expect(plan.action !== "proceed" && plan.message).toContain("rather than Jazz itself");
  });

  test("names the binary instead under launchd, where it is its own responsible process", () => {
    const plan = planInstall(
      { available: false, kind: "denied", reason: "authorization denied" },
      { ...AT_A_TERMINAL, grant: UNDER_LAUNCHD },
    );
    expect(plan.action === "grant" && plan.grant.path).toBe("/usr/local/bin/jazz");
    expect(plan.action !== "proceed" && plan.message).toStartWith("Jazz needs Full Disk Access");
  });

  test("does not try to open settings where nobody is watching the screen", () => {
    const plan = planInstall(
      { available: false, kind: "denied", reason: "authorization denied" },
      { ...AT_A_TERMINAL, interactive: false },
    );
    expect(plan.action).toBe("explain");
  });

  test("does not install unattended, where nobody consented", () => {
    const plan = planInstall(
      { available: false, kind: "missing", reason: "`imsg` is not installed." },
      { ...AT_A_TERMINAL, interactive: false },
    );
    expect(plan.action).toBe("explain");
    expect(plan.action !== "proceed" && plan.message).toContain(IMSG_INSTALL_COMMAND);
  });

  test("points at Homebrew when there is no package manager to install with", () => {
    const plan = planInstall(
      { available: false, kind: "missing", reason: "`imsg` is not installed." },
      { ...AT_A_TERMINAL, homebrewPresent: false },
    );
    expect(plan.action).toBe("explain");
    expect(plan.action !== "proceed" && plan.message).toContain("brew.sh");
  });

  test("passes an unrecognised failure through rather than guessing at it", () => {
    const plan = planInstall(
      { available: false, kind: "failed", reason: "`imsg chats` failed: disk I/O error" },
      AT_A_TERMINAL,
    );
    expect(plan.action).toBe("explain");
    expect(plan.action !== "proceed" && plan.message).toContain("disk I/O error");
  });
});

describe("terminalAppName", () => {
  test("gives the app name a person will recognise in the settings list", () => {
    expect(terminalAppName({ TERM_PROGRAM: "Apple_Terminal" })).toBe("Terminal");
    expect(terminalAppName({ TERM_PROGRAM: "ghostty" })).toBe("Ghostty");
  });

  test("passes an unknown terminal through rather than guessing at it", () => {
    expect(terminalAppName({ TERM_PROGRAM: "WeirdTerm" })).toBe("WeirdTerm");
  });

  test("stays vague when nothing says what the terminal is", () => {
    expect(terminalAppName({})).toBe("your terminal app");
  });
});
