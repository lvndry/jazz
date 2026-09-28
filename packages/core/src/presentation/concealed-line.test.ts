import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import type { StreamEvent } from "@/core/types/streaming";
import { applyConcealedKeys, concealValue, readConcealedLine } from "./concealed-line";
import { OneShotPresentationService } from "./oneshot-presentation-service";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("applyConcealedKeys", () => {
  it("collects typed characters and submits on Enter", () => {
    const line = applyConcealedKeys({ value: "" }, "s3cr3t\r");
    expect(line).toEqual({ value: "s3cr3t", done: "submitted" });
  });

  it("deletes with Backspace and clears with Ctrl-U", () => {
    let line = applyConcealedKeys({ value: "" }, "abc\u007f");
    expect(line.value).toBe("ab");
    line = applyConcealedKeys(line, "\u0015xy");
    expect(line.value).toBe("xy");
  });

  it("cancels on Esc or Ctrl-C and forgets what was typed", () => {
    expect(applyConcealedKeys({ value: "half" }, "\u001b")).toEqual({
      value: "",
      done: "cancelled",
    });
    expect(applyConcealedKeys({ value: "half" }, "\u0003")).toEqual({
      value: "",
      done: "cancelled",
    });
  });

  it("ignores arrow keys instead of reading them as a cancel", () => {
    expect(applyConcealedKeys({ value: "ab" }, "\u001b[D\u001bOAc")).toEqual({ value: "abc" });
  });
});

describe("concealValue", () => {
  it("draws one bullet per character and nothing of the value", () => {
    expect(concealValue("pässwörd")).toBe("••••••••");
    expect(concealValue("")).toBe("");
  });
});

describe("readConcealedLine", () => {
  it("reads the first piped line without echoing it", async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const output = new PassThrough();
    output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const pending = readConcealedLine("Secret: ", {
      input: input as unknown as NodeJS.ReadStream,
      output,
    });
    input.write("from-a-password-manager\nignored\n");
    expect(await pending).toBe("from-a-password-manager");
    expect(written.join("")).not.toContain("from-a-password-manager");
  });
});

describe("OneShotPresentationService.requestSecretInput", () => {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  function captureStderr(): string[] {
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    return lines;
  }

  const eventTypes = new Set<StreamEvent["type"]>(["approval_required"]);

  it("asks a bridge with the prompt and name, and takes the value off stdin", async () => {
    const stderr = captureStderr();
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      eventTypes,
      stdin,
      undefined,
      "protocol",
    );
    const pending = Effect.runPromise(
      service.requestSecretInput({ prompt: "Password for a.pdf", name: "pdf-password" }),
    );
    await tick();
    const asked = JSON.parse(stderr.join("").trim()) as Record<string, unknown>;
    expect(asked).toEqual({
      type: "user_secret_required",
      requestId: "secret-1",
      prompt: "Password for a.pdf",
      name: "pdf-password",
    });
    stdin.write(
      `${JSON.stringify({ type: "user_secret_response", requestId: "secret-1", value: "v4lue-typed" })}\n`,
    );
    expect(await pending).toEqual({ kind: "provided", value: "v4lue-typed" });
    expect(stderr.join("")).not.toContain("v4lue-typed");
  });

  it("reads a bridge's shared-chat refusal and a decline", async () => {
    captureStderr();
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      eventTypes,
      stdin,
      undefined,
      "protocol",
    );
    const shared = Effect.runPromise(service.requestSecretInput({ prompt: "p", name: "a" }));
    const declined = Effect.runPromise(service.requestSecretInput({ prompt: "p", name: "b" }));
    await tick();
    stdin.write(
      `${JSON.stringify({ type: "user_secret_response", requestId: "secret-1", unavailable: "shared-chat" })}\n` +
        `${JSON.stringify({ type: "user_secret_response", requestId: "secret-2", declined: true })}\n`,
    );
    expect(await shared).toEqual({ kind: "unavailable", reason: "shared-chat" });
    expect(await declined).toEqual({ kind: "declined" });
  });

  it("reports nobody to ask when no one is listening", async () => {
    const service = new OneShotPresentationService(DEFAULT_DISPLAY_CONFIG, new Set());
    expect(await Effect.runPromise(service.requestSecretInput({ prompt: "p", name: "a" }))).toEqual(
      { kind: "unavailable" },
    );
  });

  it("at a terminal, keeps the typed keys away from the question reader", async () => {
    const stderr = captureStderr();
    const stdin = new PassThrough();
    const service = new OneShotPresentationService(
      DEFAULT_DISPLAY_CONFIG,
      eventTypes,
      stdin,
      undefined,
      "tty",
    );
    const question = Effect.runPromise(
      service.requestUserInput({ question: "Which?", suggestions: [], allowCustom: true }),
    );
    await tick();
    const secret = Effect.runPromise(service.requestSecretInput({ prompt: "PIN", name: "pin" }));
    await tick();
    stdin.write("typed-pin-value\n");
    expect(await secret).toEqual({ kind: "provided", value: "typed-pin-value" });
    stdin.write("the answer\n");
    expect(await question).toEqual({ kind: "answered", response: "the answer" });
    expect(stderr.join("")).not.toContain("typed-pin-value");
  });
});
