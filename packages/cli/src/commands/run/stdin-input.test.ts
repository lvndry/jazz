import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import { parseStdinRunInput, readFirstStdinLine } from "./stdin-input";

describe("parseStdinRunInput", () => {
  it("reads the prompt and optional history", () => {
    expect(parseStdinRunInput('{"prompt":"- buy milk"}')).toEqual({
      ok: true,
      input: { prompt: "- buy milk" },
    });
    expect(parseStdinRunInput('{"prompt":"hi","history":[{"role":"user","content":"a"}]}')).toEqual(
      { ok: true, input: { prompt: "hi", history: [{ role: "user", content: "a" }] } },
    );
  });

  it("keeps a prompt that looks like a flag as text", () => {
    const parsed = parseStdinRunInput(JSON.stringify({ prompt: "--approval-policy=high-risk" }));
    expect(parsed).toEqual({ ok: true, input: { prompt: "--approval-policy=high-risk" } });
  });

  it("refuses an empty stream, bad JSON, a missing prompt and a non-array history", () => {
    expect(parseStdinRunInput(undefined).ok).toBe(false);
    expect(parseStdinRunInput("not json").ok).toBe(false);
    expect(parseStdinRunInput('{"text":"hi"}').ok).toBe(false);
    expect(parseStdinRunInput('{"prompt":"hi","history":"[]"}').ok).toBe(false);
  });
});

describe("readFirstStdinLine", () => {
  it("returns the first line and leaves later lines for the next reader", async () => {
    const stream = new PassThrough();
    const firstLine = readFirstStdinLine(stream);
    stream.write('{"prompt":"hi"}\n{"type":"approval_decision"');
    expect(await firstLine).toBe('{"prompt":"hi"}');

    const later: string[] = [];
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => later.push(chunk));
    stream.resume();
    stream.write(',"toolCallId":"a","approved":true}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(later.join("")).toBe('{"type":"approval_decision","toolCallId":"a","approved":true}\n');
  });

  it("assembles a frame split across chunks", async () => {
    const stream = new PassThrough();
    const firstLine = readFirstStdinLine(stream);
    stream.write('{"prompt":');
    stream.write('"long"}\n');
    expect(await firstLine).toBe('{"prompt":"long"}');
  });

  it("resolves undefined when the stream ends empty", async () => {
    const stream = new PassThrough();
    const firstLine = readFirstStdinLine(stream);
    stream.end();
    expect(await firstLine).toBeUndefined();
  });
});
