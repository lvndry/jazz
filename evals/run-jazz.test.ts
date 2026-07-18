import { describe, expect, it } from "bun:test";
import { parseEnvelope } from "./run-jazz";

describe("parseEnvelope", () => {
  it("parses the jazz --json envelope from the last stdout line", () => {
    const line = JSON.stringify({
      ok: true,
      answer: "hi",
      costUSD: 0.001,
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }],
    });
    const parsed = parseEnvelope(`some noise on an earlier line\n${line}\n`);
    expect(parsed.ok).toBe(true);
    expect(parsed.answer).toBe("hi");
    expect(parsed.costUSD).toBe(0.001);
    expect(parsed.tokenUsage.totalTokens).toBe(15);
    expect(parsed.toolCalls[0]?.name).toBe("read_file");
  });

  it("throws on non-JSON output", () => {
    expect(() => parseEnvelope("garbage not json")).toThrow();
  });

  it("throws when ok is false", () => {
    expect(() => parseEnvelope(JSON.stringify({ ok: false, error: "boom" }))).toThrow(/boom/);
  });

  it("throws on empty output", () => {
    expect(() => parseEnvelope("   \n  \n")).toThrow();
  });
});
