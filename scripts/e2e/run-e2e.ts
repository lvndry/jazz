/**
 * End-to-end check of the `jazz run --json` contract against a scripted model server.
 *
 * Starts `stub-provider.ts` in-process, points a throwaway Jazz home at it through the vLLM
 * provider, and runs the real CLI as a child process for each case:
 *
 * - a plain answer: exit 0, `ok: true`, the answer, no tool calls;
 * - a tool call: the stub calls `read_file`, Jazz runs it, and the answer carries the file;
 * - an approval park: an unallowlisted `execute_command` under `--park` exits 2 with an
 *   `input-required` envelope naming the tool;
 * - the approval: `jazz runs approve <runId> --json` resumes the parked run to `ok: true`.
 *
 * Usage: `bun run test:e2e`. Set `JAZZ_BIN` to a compiled binary to test that instead of the
 * sources (CI runs it against the binary it just built). Exits non-zero on the first failed
 * expectation and prints the command, its exit code and its output.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startStubProvider, STUB_MODEL_ID } from "./stub-provider";

/** Longest a single CLI invocation may take before the case is failed. */
const COMMAND_TIMEOUT_MS = 60_000;

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SOURCE_ENTRYPOINT = ["bun", join(REPO_ROOT, "packages/runtime/src/main.ts")];

interface CommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type Envelope = Record<string, unknown>;

function jazzCommand(): readonly string[] {
  const binary = process.env["JAZZ_BIN"];
  return binary !== undefined && binary.length > 0 ? [binary] : SOURCE_ENTRYPOINT;
}

interface JazzEnvironment extends Record<string, string> {
  readonly JAZZ_HOME: string;
}

async function runJazz(
  args: readonly string[],
  environment: JazzEnvironment,
): Promise<CommandResult> {
  const command = [...jazzCommand(), ...args];
  const child = Bun.spawn(command, {
    cwd: environment.JAZZ_HOME,
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { command: command.join(" "), exitCode, stdout, stderr };
}

function fail(result: CommandResult, reason: string): never {
  process.stderr.write(
    `FAIL: ${reason}\n  command: ${result.command}\n  exit: ${result.exitCode}\n` +
      `  stdout: ${result.stdout.trim()}\n  stderr (tail): ${result.stderr.trim().split("\n").slice(-15).join("\n    ")}\n`,
  );
  process.exit(1);
}

function envelopeOf(result: CommandResult): Envelope {
  const lines = result.stdout.trim().split("\n");
  if (lines.length !== 1) {
    fail(result, `expected exactly one line on stdout, got ${lines.length}`);
  }
  try {
    return JSON.parse(lines[0] ?? "") as Envelope;
  } catch {
    fail(result, "stdout is not a JSON envelope");
  }
}

function expectThat(result: CommandResult, condition: boolean, reason: string): void {
  if (!condition) {
    fail(result, reason);
  }
}

function toolNames(envelope: Envelope): readonly string[] {
  const calls = envelope["toolCalls"];
  return Array.isArray(calls) ? calls.map((call) => String((call as Envelope)["name"])) : [];
}

async function main(): Promise<void> {
  const server = startStubProvider();
  const home = mkdtempSync(join(tmpdir(), "jazz-e2e-"));
  try {
    mkdirSync(join(home, "agents"));
    writeFileSync(
      join(home, "agents", "e2e.json"),
      JSON.stringify({
        id: "e2e",
        name: "e2e",
        description: "End-to-end test agent",
        config: {
          persona: "default",
          llm: { provider: "vllm", model: STUB_MODEL_ID },
          tools: ["read_file", "execute_command"],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const fixturePath = join(home, "fixture.txt");
    const fixtureText = "the fixture says hello";
    writeFileSync(fixturePath, fixtureText);

    const environment: JazzEnvironment = {
      JAZZ_HOME: home,
      JAZZ_DISABLE_KEYRING: "1",
      JAZZ_DISABLE_CATCH_UP: "1",
      JAZZ_OFFLINE: "1",
      VLLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    };
    const run = (...args: string[]) =>
      runJazz(["run", "--agent", "e2e", "--json", ...args], environment);

    const answered = await run("[e2e:answer]");
    const answer = envelopeOf(answered);
    expectThat(answered, answered.exitCode === 0, "a plain answer exits 0");
    expectThat(answered, answer["ok"] === true, "a plain answer is ok:true");
    expectThat(answered, answer["answer"] === "e2e answer", "the envelope carries the answer");
    expectThat(answered, toolNames(answer).length === 0, "a plain answer calls no tools");
    process.stdout.write("ok   plain answer\n");

    const read = await run(`[e2e:read path=${fixturePath}]`);
    const readEnvelope = envelopeOf(read);
    expectThat(read, read.exitCode === 0, "a tool-calling run exits 0");
    expectThat(read, readEnvelope["ok"] === true, "a tool-calling run is ok:true");
    expectThat(read, toolNames(readEnvelope).includes("read_file"), "the run reports read_file");
    expectThat(
      read,
      String(readEnvelope["answer"]).includes(fixtureText),
      "the answer carries the tool result",
    );
    process.stdout.write("ok   tool call\n");

    const parked = await run("--park", "[e2e:shell command=echo approved-by-e2e]");
    const parkedEnvelope = envelopeOf(parked);
    const pending = parkedEnvelope["pending"] as Envelope | undefined;
    expectThat(parked, parked.exitCode === 2, "a run waiting for approval exits 2");
    expectThat(parked, parkedEnvelope["ok"] === false, "a parked run is ok:false");
    expectThat(parked, parkedEnvelope["state"] === "input-required", "state is input-required");
    expectThat(parked, pending?.["toolName"] === "execute_command", "pending names the tool");
    const runId = parkedEnvelope["runId"];
    expectThat(parked, typeof runId === "string" && runId.length > 0, "the envelope has a runId");
    process.stdout.write("ok   approval park (exit 2)\n");

    const approved = await runJazz(["runs", "approve", String(runId), "--json"], environment);
    const approvedEnvelope = envelopeOf(approved);
    expectThat(approved, approved.exitCode === 0, "approving the parked run exits 0");
    expectThat(approved, approvedEnvelope["ok"] === true, "the resumed run is ok:true");
    expectThat(
      approved,
      String(approvedEnvelope["answer"]).includes("approved-by-e2e"),
      "the resumed run ran the approved command",
    );
    process.stdout.write("ok   approve and resume\n");
  } finally {
    await server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
