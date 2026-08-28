import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { misfireLogPath, readMisfires, recordMisfire } from "./misfire-log";

let jazzHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-misfire-log-"));
  previousHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
  await nodeFs.rm(jazzHome, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> => Effect.runPromise(effect);

describe("the tool-misfire log", () => {
  it("returns nothing before any tool has failed", async () => {
    expect(await run(readMisfires())).toEqual([]);
  });

  it("records a runtime error with its args", async () => {
    await run(
      recordMisfire("web_search", "runtime_error", "network timeout", 1200, { query: "x" }),
    );

    const [logged] = await run(readMisfires());
    expect(logged?.toolName).toBe("web_search");
    expect(logged?.kind).toBe("runtime_error");
    expect(logged?.errorMessage).toBe("network timeout");
    expect(logged?.args).toContain("query");
  });

  it("records tool-not-found without args and without throwing", async () => {
    await run(recordMisfire("bogus_tool", "tool_not_found", "Tool not found: bogus_tool", 0));

    const [logged] = await run(readMisfires());
    expect(logged?.kind).toBe("tool_not_found");
    expect(logged?.args).toBeUndefined();
  });

  it("filters to one tool", async () => {
    await run(recordMisfire("tool_a", "runtime_error", "boom", 10));
    await run(recordMisfire("tool_b", "runtime_error", "boom", 10));

    const entries = await run(readMisfires({ toolName: "tool_b" }));
    expect(entries.map((logged) => logged.toolName)).toEqual(["tool_b"]);
  });

  it("orders entries newest first", async () => {
    await run(recordMisfire("tool_a", "runtime_error", "first", 10));
    await run(recordMisfire("tool_a", "runtime_error", "second", 10));

    const entries = await run(readMisfires());
    expect(entries.map((logged) => logged.errorMessage)).toEqual(["second", "first"]);
  });

  it("skips a line a crash left half-written rather than losing the file", async () => {
    await run(recordMisfire("tool_a", "runtime_error", "before the crash", 10));
    await nodeFs.appendFile(misfireLogPath(), '{"toolName":"tool_a","kin', "utf-8");
    await run(recordMisfire("tool_a", "runtime_error", "after the crash", 10));

    const messages = (await run(readMisfires())).map((logged) => logged.errorMessage);
    expect(messages).toContain("before the crash");
    expect(messages).toContain("after the crash");
  });

  it("never throws when the log cannot be written", async () => {
    process.env["JAZZ_HOME"] = "/proc/nonexistent-and-unwritable";
    await expect(
      run(recordMisfire("tool_a", "runtime_error", "boom", 10)),
    ).resolves.toBeUndefined();
    process.env["JAZZ_HOME"] = jazzHome;
  });

  it("truncates oversized args instead of writing them in full", async () => {
    const bigValue = "x".repeat(3_000);
    await run(recordMisfire("tool_a", "runtime_error", "boom", 10, { bigValue }));

    const [logged] = await run(readMisfires());
    expect(logged?.args?.length).toBeLessThan(3_000);
    expect(logged?.args?.endsWith("...")).toBe(true);
  });
});
