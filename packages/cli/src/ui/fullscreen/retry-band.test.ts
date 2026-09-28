import { describe, expect, it } from "bun:test";
import { getGlyphs } from "../glyphs";
import type { RetryNotice } from "../store";
import { THEME } from "../theme";
import { liveRows } from "./LiveZone";
import { retryBand } from "./retry-band";

const NOTICE: RetryNotice = {
  agentName: "sol",
  provider: "openai",
  reason: "rate limit",
  detail: "Too Many Requests",
  statusCode: 429,
  attempt: 2,
  maxAttempts: 5,
  retryInMs: 8_000,
  retryAt: 10_000,
};

describe("retryBand", () => {
  it("names the provider, the status and a countdown to the real retry time", () => {
    expect(retryBand(NOTICE, 2_000)).toEqual({
      title: "The model provider is rate limiting",
      cause: "OpenAI returned 429.",
      secondsLeft: 8,
      attempt: "attempt 2 of 5",
    });
    expect(retryBand(NOTICE, 9_500).secondsLeft).toBe(1);
    expect(retryBand(NOTICE, 12_000).secondsLeft).toBe(0);
  });

  it("falls back to the provider's own message when there is no status", () => {
    const { statusCode: _statusCode, ...withoutStatus } = NOTICE;
    const band = retryBand(
      { ...withoutStatus, reason: "network issue", detail: "fetch failed" },
      0,
    );
    expect(band.title).toBe("Can't reach the model provider");
    expect(band.cause).toBe("OpenAI: fetch failed.");
  });
});

describe("the retry band in the live zone", () => {
  it("takes the top rows with the error bar, says nothing is lost, and replaces the waiting line", () => {
    const rows = liveRows(
      {
        tools: [],
        hiddenTools: [],
        waiting: "comping behind you",
        reservedRows: 4,
        retry: retryBand(NOTICE, 2_000),
      },
      { width: 100, height: 30 },
    );
    const text = rows.map((row) => row.segments.map((segment) => segment.text).join(""));
    expect(text[0]).toContain("The model provider is rate limiting");
    expect(text[0]).toContain("attempt 2 of 5");
    expect(text[1]).toContain("Retrying in 8s. Nothing is lost.");
    expect(text[2]).toContain("esc esc stop retrying");
    expect(text.join("\n")).not.toContain("comping behind you");
    expect(rows[0]?.segments[0]).toEqual({ text: `${getGlyphs().bandBar} `, fg: THEME.error });
    expect(rows[0]?.background).toBe(THEME.surface);
  });
});
