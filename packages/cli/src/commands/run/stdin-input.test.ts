/** Framed stdin preserves prompts and subsequent protocol bytes across arbitrary chunks. */
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
  it("preserves multibyte prompt and history characters split between chunks", async () => {
    const stream = new PassThrough();
    const frame = JSON.stringify({
      prompt: "café 👋",
      history: [{ role: "user", content: "日本語" }],
    });
    const firstLine = readFirstStdinLine(stream);
    for (const byte of Buffer.from(`${frame}\n`)) stream.write(Buffer.from([byte]));
    expect(await firstLine).toBe(frame);
    stream.destroy();
  });

  it("returns later protocol bytes unchanged when their UTF-8 character is split", async () => {
    const stream = new PassThrough();
    const frame = '{"prompt":"hi"}';
    const reply = Buffer.from('{"response":"👋"}\n');
    const split = reply.indexOf(Buffer.from("👋")) + 1;
    const firstLine = readFirstStdinLine(stream);
    stream.write(Buffer.concat([Buffer.from(`${frame}\n`), reply.subarray(0, split)]));
    expect(await firstLine).toBe(frame);
    const remainder: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => remainder.push(chunk));
    const ended = new Promise<void>((resolve) => stream.on("end", resolve));
    stream.resume();
    stream.end(reply.subarray(split));
    await ended;
    expect(Buffer.concat(remainder)).toEqual(reply);
  });

  it("decodes a split multibyte character when EOF terminates the frame", async () => {
    const stream = new PassThrough();
    const frame = JSON.stringify({ prompt: "👋" });
    const firstLine = readFirstStdinLine(stream);
    for (const byte of Buffer.from(frame)) stream.write(Buffer.from([byte]));
    stream.end();
    expect(await firstLine).toBe(frame);
  });

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
