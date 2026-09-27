import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresentationService, StreamingRenderer } from "@jazz/core/interfaces/presentation";
import type { StreamEvent } from "@jazz/core/types/streaming";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  DetachEventRecorder,
  detachEventLogPath,
  parseDetachEvent,
  projectStreamEvent,
  readDetachEventLines,
  recordingPresentationService,
} from "./events";

describe("detach event log", () => {
  let home: string;
  const priorHome = process.env["JAZZ_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jazz-detach-events-"));
    process.env["JAZZ_HOME"] = home;
  });

  afterEach(() => {
    if (priorHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = priorHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function loggedEvents(): unknown[] {
    return readFileSync(detachEventLogPath("handoff"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const { at: _at, ...event } = JSON.parse(line) as Record<string, unknown>;
        return event;
      });
  }

  it("coalesces streamed text into one line before the next event", async () => {
    const recorder = new DetachEventRecorder("handoff");
    recorder.record({ type: "text", delta: "Hel" });
    recorder.record({ type: "text", delta: "lo" });
    recorder.record({ type: "response_end" });
    await recorder.close();
    expect(loggedEvents()).toEqual([{ type: "text", delta: "Hello" }, { type: "response_end" }]);
    expect(recorder.sawText).toBe(true);
  });

  it("keeps only what a terminal replays from runner stream events", () => {
    const chunk: StreamEvent = { type: "text_chunk", delta: "a", accumulated: "a", sequence: 1 };
    expect(projectStreamEvent(chunk)).toEqual({ type: "text", delta: "a" });
    expect(projectStreamEvent({ type: "thinking_chunk", content: "x", sequence: 1 })).toBe(
      undefined,
    );
    expect(
      projectStreamEvent({
        type: "tool_execution_complete",
        toolCallId: "call",
        result: "raw output",
        durationMs: 5,
        success: false,
        error: "boom",
      }),
    ).toEqual({
      type: "tool_end",
      toolCallId: "call",
      success: false,
      durationMs: 5,
      summary: "boom",
    });
  });

  it("leaves approval requests to the parked status, since a resume re-emits them", () => {
    expect(
      projectStreamEvent({
        type: "approval_required",
        toolCallId: "call",
        toolName: "write_file",
        message: "About to write",
      }),
    ).toBeUndefined();
  });

  it("resumes from a byte offset and never returns a half-written line", async () => {
    mkdirSync(join(home, "detach", "jobs"), { recursive: true });
    const file = detachEventLogPath("handoff");
    const first = `${JSON.stringify({ type: "user", text: "go", at: "t" })}\n`;
    writeFileSync(file, `${first}{"type":"te`);
    const initial = await readDetachEventLines("handoff", 0);
    expect(initial.lines).toHaveLength(1);
    expect(initial.nextByte).toBe(Buffer.byteLength(first));
    appendFileSync(file, `xt","delta":"hi","at":"t"}\n`);
    const next = await readDetachEventLines("handoff", initial.nextByte);
    expect(next.lines.map(parseDetachEvent)).toEqual([{ type: "text", delta: "hi", at: "t" }]);
  });

  it("returns an empty read for a job that has logged nothing yet", async () => {
    expect(await readDetachEventLines("handoff", 0)).toEqual({ lines: [], nextByte: 0 });
  });

  it("rejects remote lines that do not match the event vocabulary", () => {
    expect(parseDetachEvent("not json")).toBeUndefined();
    expect(parseDetachEvent(JSON.stringify({ type: "text", delta: 1, at: "t" }))).toBeUndefined();
    expect(parseDetachEvent(JSON.stringify({ type: "shell", command: "rm", at: "t" }))).toBe(
      undefined,
    );
    expect(parseDetachEvent(JSON.stringify({ type: "status", state: "parked" }))).toBeUndefined();
  });

  it("tees renderer events into the log while the wrapped service still renders them", async () => {
    const rendered: StreamEvent[] = [];
    const renderer: StreamingRenderer = {
      handleEvent: (event) => Effect.sync(() => void rendered.push(event)),
      setInterruptHandler: () => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };
    const inner = {
      createStreamingRenderer: () => Effect.succeed(renderer),
      renderMarkdown: (markdown: string) => Effect.succeed(`md:${markdown}`),
    } as unknown as PresentationService;
    const recorder = new DetachEventRecorder("handoff");
    const service = recordingPresentationService(inner, recorder);
    const wrapped = await Effect.runPromise(
      service.createStreamingRenderer(
        {} as Parameters<PresentationService["createStreamingRenderer"]>[0],
      ),
    );
    const event: StreamEvent = {
      type: "tool_execution_start",
      toolName: "read_file",
      toolCallId: "call",
      arguments: { path: "a.txt" },
    };
    await Effect.runPromise(wrapped.handleEvent(event));
    await recorder.close();
    expect(rendered).toEqual([event]);
    expect(loggedEvents()).toEqual([
      {
        type: "tool_start",
        toolCallId: "call",
        toolName: "read_file",
        arguments: '{"path":"a.txt"}',
      },
    ]);
    expect(service.emitsToolEventsViaRenderer?.()).toBe(true);
    expect(await Effect.runPromise(service.renderMarkdown("x"))).toBe("md:x");
  });
});
