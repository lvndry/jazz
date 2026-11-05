import { describe, expect, it } from "bun:test";
import { createScrubber, REDACTED_PLACEHOLDER, type HostFacts } from "./scrub";

const HOST: HostFacts = {
  home: "/Users/someone-private",
  username: "someone-private",
  hostname: "private-laptop.local",
  tmpdir: "/var/folders/zz/abc123/T",
};

const CANARY_SECRET = "canary-secret-value-7f3a9c2e41";
const CANARY_API_KEY = "sk-canaryCANARYcanary1234567890abcd";

describe("session fixture scrubbing", () => {
  it("never lets a canary secret survive, however it is nested or encoded", () => {
    const scrubber = createScrubber({ secrets: [CANARY_SECRET], hostFacts: HOST });
    const recorded = {
      parts: [
        { type: "text-delta", text: `the token is ${CANARY_SECRET}, keep it safe` },
        {
          type: "tool-call",
          toolName: "execute_command",
          input: { command: `curl -H 'Authorization: Bearer ${CANARY_SECRET}${CANARY_SECRET}' x` },
        },
      ],
      headers: { authorization: CANARY_API_KEY, "x-note": `key=${CANARY_API_KEY}` },
      [`field-${CANARY_SECRET}`]: "value",
      encodedArguments: JSON.stringify({ apiKey: CANARY_SECRET, other: CANARY_API_KEY }),
    };

    const serialized = JSON.stringify(scrubber.scrub(recorded));

    expect(serialized).not.toContain(CANARY_SECRET);
    expect(serialized).not.toContain(CANARY_API_KEY);
    expect(serialized).not.toContain("canaryCANARY");
    expect(serialized).toContain(REDACTED_PLACEHOLDER);
  });

  it("replaces host facts, timestamps and random ids with stable placeholders", () => {
    const scrubber = createScrubber({ hostFacts: HOST });
    const scrubbed = scrubber.scrub({
      path: `${HOST.home}/projects/app/${HOST.username}.txt`,
      scratch: `${HOST.tmpdir}/jazz-1/out.log`,
      host: `running on ${HOST.hostname}`,
      at: "2026-11-05T15:44:08.123Z",
      timestamp: 1_793_000_000_000,
      first: "call_AbCdEfGh12345678",
      again: "call_AbCdEfGh12345678",
      other: "toolu_ZyXwVuTs98765432",
    });
    const serialized = JSON.stringify(scrubbed);

    for (const leaked of [
      HOST.home,
      HOST.username,
      HOST.hostname,
      HOST.tmpdir,
      "2026-11-05",
      "AbCdEfGh",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(scrubbed.timestamp).toBe(0);
    expect(scrubbed.first).toBe(scrubbed.again);
    expect(scrubbed.first).not.toBe(scrubbed.other);
  });

  it("scrubs two recordings of the same session to identical output", () => {
    const record = (callId: string): unknown => ({
      id: callId,
      path: `${HOST.home}/a`,
      nested: [{ toolCallId: callId }],
    });
    const first = createScrubber({ hostFacts: HOST }).scrub(record("call_1111111111111111"));
    const second = createScrubber({ hostFacts: HOST }).scrub(record("call_2222222222222222"));
    expect(second).toEqual(first);
  });

  it("does not mutate its input", () => {
    const scrubber = createScrubber({ secrets: [CANARY_SECRET], hostFacts: HOST });
    const input = { text: CANARY_SECRET };
    scrubber.scrub(input);
    expect(input.text).toBe(CANARY_SECRET);
  });
});
