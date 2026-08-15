import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { formatTaskState, patchTaskState, readTaskState, taskStatePath } from "./task-state";

const runEffect = <A>(effect: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(effect);
const now = "2026-08-15T12:00:00.000Z";

describe("task state", () => {
  let jazzHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-task-state-"));
    previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("returns nothing before anything is written", async () => {
    expect(await runEffect(readTaskState("agent-1", "conv-1"))).toBeUndefined();
  });

  it("patches one field without disturbing the rest", async () => {
    await runEffect(
      patchTaskState(
        "agent-1",
        "conv-1",
        {
          goal: "migrate the routes",
          decisions: ["keep the old adapter until v3"],
          openQuestions: ["does the legacy client still call /v1?"],
        },
        now,
      ),
    );

    await runEffect(patchTaskState("agent-1", "conv-1", { nextStep: "migrate auth route" }, now));

    const state = await runEffect(readTaskState("agent-1", "conv-1"));
    expect(state?.goal).toBe("migrate the routes");
    expect(state?.decisions).toEqual(["keep the old adapter until v3"]);
    expect(state?.openQuestions).toEqual(["does the legacy client still call /v1?"]);
    expect(state?.nextStep).toBe("migrate auth route");
  });

  it("replaces a field that is explicitly patched", async () => {
    await runEffect(patchTaskState("agent-1", "conv-1", { nextStep: "first" }, now));
    await runEffect(patchTaskState("agent-1", "conv-1", { nextStep: "second" }, now));

    expect((await runEffect(readTaskState("agent-1", "conv-1")))?.nextStep).toBe("second");
  });

  it("keeps state per conversation", async () => {
    await runEffect(patchTaskState("agent-1", "conv-1", { goal: "one" }, now));
    await runEffect(patchTaskState("agent-1", "conv-2", { goal: "two" }, now));

    expect((await runEffect(readTaskState("agent-1", "conv-1")))?.goal).toBe("one");
    expect((await runEffect(readTaskState("agent-1", "conv-2")))?.goal).toBe("two");
  });

  it("survives a corrupt state file rather than throwing", async () => {
    await runEffect(patchTaskState("agent-1", "conv-1", { goal: "one" }, now));
    await nodeFs.writeFile(taskStatePath("agent-1", "conv-1"), "{not json", "utf-8");

    expect(await runEffect(readTaskState("agent-1", "conv-1"))).toBeUndefined();
  });

  it("renders work item verification status", () => {
    const formatted = formatTaskState({
      goal: "migrate the routes",
      workItems: [
        { description: "auth route", status: "done", verifiedBy: "bun test src/auth.test.ts" },
        { description: "billing route", status: "unverified" },
      ],
      nextStep: "verify billing",
    });

    expect(formatted).toContain("migrate the routes");
    expect(formatted).toContain("[done] auth route (verified by: bun test src/auth.test.ts)");
    expect(formatted).toContain("[unverified] billing route");
    expect(formatted).toContain("**Next step:** verify billing");
  });

  it("renders nothing for empty state", () => {
    expect(formatTaskState(undefined)).toBeUndefined();
    expect(formatTaskState({})).toBeUndefined();
  });
});
