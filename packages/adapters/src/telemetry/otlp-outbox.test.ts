import { mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { OtlpOutbox } from "./otlp-outbox";

const ENDPOINTS = {
  traces: "https://collector.test/v1/traces",
  logs: "https://collector.test/v1/logs",
  metrics: "https://collector.test/v1/metrics",
} as const;

describe("OtlpOutbox", () => {
  it("stores private payloads without endpoint or credentials in the queue", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-outbox-"));
    try {
      const queue = new OtlpOutbox(directory, ENDPOINTS, 1024, 60_000);
      await queue.enqueue("traces", '{"resourceSpans":[]}');
      const queueDir = path.join(directory, "otlp-outbox");
      const files = await readdir(queueDir);
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain("collector.test");
      expect(await readFile(path.join(queueDir, files[0]!), "utf8")).toBe('{"resourceSpans":[]}');
      expect((await stat(queueDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(queueDir, files[0]!))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a retryable request and drops a permanently rejected one", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-outbox-"));
    const dropped: string[] = [];
    try {
      const queue = new OtlpOutbox(directory, ENDPOINTS, 1024, 60_000, (count, reason) =>
        dropped.push(`${count}:${reason}`),
      );
      await queue.enqueue("logs", '{"first":1}');
      await queue.drain("logs", async () => "retry");
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(1);
      await queue.drain("logs", async () => "rejected");
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(0);
      expect(dropped).toEqual(["1:permanent"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds retained bytes and evicts the oldest request first", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-outbox-"));
    const dropped: string[] = [];
    try {
      const queue = new OtlpOutbox(directory, ENDPOINTS, 20, 60_000, (count, reason) =>
        dropped.push(`${count}:${reason}`),
      );
      await queue.enqueue("logs", "first-request");
      await queue.enqueue("logs", "second-request");
      const sent: string[] = [];
      await queue.drain("logs", async (body) => {
        sent.push(body);
        return "accepted";
      });
      expect(sent).toEqual(["second-request"]);
      expect(dropped).toEqual(["1:capacity_or_age"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prunes expired requests before attempting delivery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-outbox-"));
    const dropped: string[] = [];
    try {
      const queue = new OtlpOutbox(directory, ENDPOINTS, 1024, 1, (count, reason) =>
        dropped.push(`${count}:${reason}`),
      );
      await queue.enqueue("traces", "expired");
      await new Promise((resolve) => setTimeout(resolve, 5));
      let sent = 0;
      await queue.drain("traces", async () => {
        sent += 1;
        return "accepted";
      });
      expect(sent).toBe(0);
      expect(dropped).toContain("1:capacity_or_age");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never sends an old destination's data to a new endpoint", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-outbox-"));
    try {
      const oldQueue = new OtlpOutbox(directory, ENDPOINTS, 1024, 60_000);
      await oldQueue.enqueue("traces", '{"old":true}');
      const newQueue = new OtlpOutbox(
        directory,
        { ...ENDPOINTS, traces: "https://new-collector.test/v1/traces" },
        1024,
        60_000,
      );
      let sent = 0;
      await newQueue.drain("traces", async () => {
        sent += 1;
        return "accepted";
      });
      expect(sent).toBe(0);
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets only one of two drainers send a claimed request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-outbox-"));
    try {
      const first = new OtlpOutbox(directory, ENDPOINTS, 1024, 60_000);
      const second = new OtlpOutbox(directory, ENDPOINTS, 1024, 60_000);
      await first.enqueue("logs", "one-request");
      let sendCount = 0;
      let startSending: (() => void) | undefined;
      let finishSending: (() => void) | undefined;
      const sending = new Promise<void>((resolve) => {
        startSending = resolve;
      });
      const finish = new Promise<void>((resolve) => {
        finishSending = resolve;
      });
      const firstDrain = first.drain("logs", async () => {
        sendCount += 1;
        startSending?.();
        await finish;
        return "accepted";
      });
      await sending;
      await second.drain("logs", async () => {
        sendCount += 1;
        return "accepted";
      });
      finishSending?.();
      await firstDrain;
      expect(sendCount).toBe(1);
      expect(await readdir(path.join(directory, "otlp-outbox"))).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a claim left by a dead process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-outbox-"));
    try {
      const queue = new OtlpOutbox(directory, ENDPOINTS, 1024, 60_000);
      await queue.enqueue("traces", "recoverable");
      const queueDir = path.join(directory, "otlp-outbox");
      const [file] = await readdir(queueDir);
      await rename(
        path.join(queueDir, file!),
        path.join(queueDir, `.claim-999999999-${String(Date.now()).padStart(13, "0")}-${file}`),
      );
      const sent: string[] = [];
      await queue.drain("traces", async (body) => {
        sent.push(body);
        return "accepted";
      });
      expect(sent).toEqual(["recoverable"]);
      expect(await readdir(queueDir)).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
