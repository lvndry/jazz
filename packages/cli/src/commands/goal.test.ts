import { AGENT_PROCESS_ENV } from "@jazz/core/utils/env";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Effect } from "effect";
import { decideProposedGoalCommand } from "./goal";

const previous = process.env[AGENT_PROCESS_ENV];

afterEach(() => {
  if (previous === undefined) {
    delete process.env[AGENT_PROCESS_ENV];
  } else {
    process.env[AGENT_PROCESS_ENV] = previous;
  }
  process.exitCode = 0;
});

describe("jazz goal accept, run by an agent", () => {
  it("refuses, since accepting a goal is the user's decision", async () => {
    process.env[AGENT_PROCESS_ENV] = "1";
    const written: string[] = [];
    const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await Effect.runPromise(
        // Refused before any service is used, so none is provided.
        decideProposedGoalCommand({
          id: "any",
          accept: true,
          json: true,
          approvalPolicy: "high-risk",
        }) as unknown as Effect.Effect<void>,
      );
    } finally {
      stdout.mockRestore();
    }
    expect(JSON.parse(written.join(""))).toMatchObject({ ok: false });
    expect(written.join("")).toContain("started by a Jazz agent");
    expect(process.exitCode).toBe(1);
  });
});
