import { describe, expect, test } from "bun:test";
import { IMSG_INSTALL_COMMAND, planInstall } from "./install";

const AT_A_TERMINAL = { interactive: true, homebrewPresent: true };

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
    expect(plan.action).toBe("explain");
    expect(plan.action !== "proceed" && plan.message).toContain("Full Disk Access");
  });

  test("does not install unattended, where nobody consented", () => {
    const plan = planInstall(
      { available: false, kind: "missing", reason: "`imsg` is not installed." },
      { interactive: false, homebrewPresent: true },
    );
    expect(plan.action).toBe("explain");
    expect(plan.action !== "proceed" && plan.message).toContain(IMSG_INSTALL_COMMAND);
  });

  test("points at Homebrew when there is no package manager to install with", () => {
    const plan = planInstall(
      { available: false, kind: "missing", reason: "`imsg` is not installed." },
      { interactive: true, homebrewPresent: false },
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
