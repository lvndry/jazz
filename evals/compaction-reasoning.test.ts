/**
 * Exercise the actual replay CLI with private fixture history and a loopback model server.
 * Captures may query model metadata but must not submit completions; unsupported multi-call
 * summaries and unintended provider destinations must fail before measured inference.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_LOG_VERSION } from "@jazz/adapters/history/conversation-log";
import { expect, test } from "bun:test";

interface ReplayOptions {
  readonly large?: boolean;
  readonly summarizerModel?: string;
  readonly agentBaseUrl?: string;
  readonly useHostname?: boolean;
  readonly allowRemote?: boolean;
}

/** Run the real entry point without inheriting user credentials or project configuration. */
async function replay(options: ReplayOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "jazz-compaction-replay-"));
  let metadataRequests = 0;
  let completionRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/models") {
        metadataRequests += 1;
        return Response.json({ data: [{ id: "test-small", max_model_len: 8192 }] });
      }
      completionRequests += 1;
      return new Response("Unexpected inference", { status: 500 });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}/v1`;
  const agentBaseUrl =
    options.agentBaseUrl ??
    (options.useHostname ? baseUrl.replace("127.0.0.1", "localhost") : baseUrl);
  const agentId = "replay-fixture";
  const configPath = join(directory, "config.json");
  const historyPath = join(directory, "history.jsonl");
  const outputPath = join(directory, "report.json");
  mkdirSync(join(directory, "agents"));
  writeFileSync(
    configPath,
    JSON.stringify({
      storage: { type: "file", path: directory },
      llm: { vllm: { base_url: baseUrl } },
      telemetry: { enabled: false },
      logging: { level: "error", format: "plain" },
    }),
  );
  writeFileSync(
    join(directory, "agents", `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      name: "Replay fixture",
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-01T10:00:00Z",
      config: {
        persona: "default",
        tools: [],
        llm: {
          provider: "vllm",
          model: "test-small",
          numCtx: 8192,
          maxContextTokens: 8192,
          baseUrls: { vllm: agentBaseUrl },
          ...(options.summarizerModel ? { summarizerModel: options.summarizerModel } : {}),
        },
      },
    }),
  );
  const at = "2026-08-01T10:00:00Z";
  const records: unknown[] = [
    {
      type: "conversation",
      version: CONVERSATION_LOG_VERSION,
      agentId,
      conversationId: "replay-history",
      startedAt: at,
    },
    {
      type: "message",
      id: "system",
      parentId: null,
      at,
      message: { role: "system", content: "Keep the task constraints." },
    },
  ];
  for (let index = 0; index < 4; index++) {
    records.push({
      type: "message",
      id: `old-${index}`,
      parentId: index === 0 ? "system" : `old-${index - 1}`,
      at,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: options.large ? "detail ".repeat(1300) : `Saved detail ${index}`,
      },
    });
  }
  records.push(
    {
      type: "message",
      id: "recent",
      parentId: "old-3",
      at,
      message: { role: "user", content: "Continue with the recent task." },
    },
    {
      type: "context",
      id: "cut",
      parentId: "recent",
      at: "2026-08-01T10:02:00Z",
      keep: [{ from: "recent", through: "recent" }],
    },
  );
  writeFileSync(historyPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "compaction-reasoning.ts"),
      "--agent",
      agentId,
      "--history",
      historyPath,
      "--before",
      "2026-08-01T10:01:00Z",
      "--samples",
      "1",
      "--output",
      outputPath,
      ...(options.large ? [] : ["--capture-only"]),
      ...(options.allowRemote ? ["--allow-remote"] : []),
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env["PATH"],
        HOME: directory,
        JAZZ_HOME: directory,
        JAZZ_CONFIG_PATH: configPath,
        JAZZ_OFFLINE: "1",
        JAZZ_DISABLE_KEYRING: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 25_000,
    },
  );
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      stdout,
      stderr,
      metadataRequests,
      completionRequests,
      report: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : undefined,
      origin: new URL(baseUrl).origin,
      agentOrigin: new URL(agentBaseUrl).origin,
    };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("captures one production request without submitting conversation history", async () => {
  const result = await replay();
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.metadataRequests).toBeGreaterThan(0);
  expect(result.completionRequests).toBe(0);
  expect(result.stdout).toContain('"phase":"captured"');
  expect(result.stdout).toContain(`"origin":"${result.origin}"`);
  expect(result.report).toContain('"measurements": []');
}, 30_000);

test("rejects production chunk folding before any measured completion or report", async () => {
  const result = await replay({ large: true });
  expect(result.exitCode).not.toBe(0);
  expect(result.metadataRequests).toBeGreaterThan(0);
  expect(result.stderr).toContain("only single-request captures can be compared");
  const capturedRequests = Number(
    result.stderr.match(/Production requires (\d+) summarizer requests/)?.[1],
  );
  expect(capturedRequests).toBeGreaterThan(1);
  expect(result.completionRequests).toBe(0);
  expect(result.report).toBeUndefined();
}, 30_000);

test("rejects a non-vLLM summarizer before contacting the model server", async () => {
  const result = await replay({ summarizerModel: "openai/gpt-4" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("both primary and summarizer providers");
  expect(result.metadataRequests).toBe(0);
  expect(result.completionRequests).toBe(0);
  expect(result.report).toBeUndefined();
}, 30_000);

test("rejects an agent's remote endpoint override even when global routing is loopback", async () => {
  const result = await replay({ agentBaseUrl: "https://inference.invalid/v1" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--allow-remote");
  expect(result.metadataRequests).toBe(0);
  expect(result.completionRequests).toBe(0);
  expect(result.report).toBeUndefined();
}, 30_000);

test("honors explicit remote consent for an agent's hostname endpoint", async () => {
  const result = await replay({ useHostname: true, allowRemote: true });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.metadataRequests).toBeGreaterThan(0);
  expect(result.completionRequests).toBe(0);
  expect(result.stdout).toContain(`"origin":"${result.agentOrigin}"`);
  expect(result.stdout).toContain('"isLoopback":false');
  expect(result.stdout).toContain('"phase":"captured"');
}, 30_000);
