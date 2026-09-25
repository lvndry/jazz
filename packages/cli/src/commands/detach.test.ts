/** Regression checks for human-readable handoff status. */
import { describe, expect, it } from "bun:test";
import { formatDetachPull, formatDetachStatus } from "./detach";

describe("detached run status", () => {
  it("does not turn unreachable into a run failure", () => {
    expect(
      formatDetachStatus({
        handoffId: "transfer-1",
        hostName: "lysk",
        state: "unknown",
        detail: "SSH unavailable; the remote run may still be active.",
      }),
    ).toBe('transfer-1 on lysk: unknown\n"SSH unavailable; the remote run may still be active."\n');
  });

  it("shows the operator how to answer a parked run", () => {
    expect(
      formatDetachStatus({ handoffId: "transfer-2", hostName: "lysk", state: "parked" }),
    ).toContain("jazz detach approve transfer-2");
  });

  it("does not offer approval for a parked input that this version cannot answer", () => {
    const output = formatDetachStatus({
      handoffId: "transfer-4",
      hostName: "lysk",
      state: "parked",
      detail: "Run requires unsupported input",
      approvalAvailable: false,
    });
    expect(output).toContain("unsupported input");
    expect(output).not.toContain("jazz detach approve");
  });
});

describe("detached result download", () => {
  it("names changed and conflicting paths without claiming they were applied", () => {
    const output = formatDetachPull({
      handoffId: "transfer-3",
      hostName: "lysk",
      resultDirectory: "/tmp/jazz-results/transfer-3",
      changedPaths: ["src/app.ts"],
      conflicts: ["src/app.ts"],
    });
    expect(output).toContain('1 changed path:\n  "src/app.ts"');
    expect(output).toContain('1 conflict with local changes:\n  "src/app.ts"');
    expect(output).toContain(
      "Local files were not changed. This verified result requires manual reconciliation.",
    );
  });
});
