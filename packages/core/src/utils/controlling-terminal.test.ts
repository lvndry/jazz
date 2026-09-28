import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const MODULE_PATH = join(import.meta.dir, "controlling-terminal.ts");

/** Runs `script` in a new session, as the daemon runs: no controlling terminal, piped stdout. */
function runDetached(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", () => resolve(output));
  });
}

describe.skipIf(process.platform === "win32")("controlling terminal", () => {
  test("a detached process has none, and writes nothing into piped stdout", async () => {
    const output = await runDetached(`
      import { canWriteControllingTerminal, writeControllingTerminal } from ${JSON.stringify(MODULE_PATH)};
      const canWrite = canWriteControllingTerminal();
      const wrote = writeControllingTerminal("\\u001b]9;leak\\u0007");
      console.log(JSON.stringify({ canWrite, wrote }));
    `);
    expect(output).not.toContain("leak");
    expect(JSON.parse(output.trim())).toEqual({ canWrite: false, wrote: false });
  });
});
