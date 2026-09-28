import { describe, expect, it } from "bun:test";
import {
  appendCapped,
  decodeCapped,
  decodeCappedText,
  EMPTY_CAPPED_OUTPUT,
  formatRedactedCappedStream,
  type CappedOutput,
} from "./capped-output";

describe("appendCapped", () => {
  it("keeps output under the byte cap and marks truncation when a chunk overflows", () => {
    const capBytes = 8;
    let output: CappedOutput = EMPTY_CAPPED_OUTPUT;
    output = appendCapped(output, Buffer.from("abcdefghijkl", "utf8"), capBytes);

    expect(output.bytes).toBe(8);
    expect(output.truncated).toBe(true);
    expect(decodeCapped(output)).toBe("abcdefgh");
  });

  it("does not mark truncation when output lands exactly on the cap", () => {
    const capBytes = 4;
    const output = appendCapped(EMPTY_CAPPED_OUTPUT, Buffer.from("abcd", "utf8"), capBytes);

    expect(output.bytes).toBe(4);
    expect(output.truncated).toBe(false);
    expect(decodeCapped(output)).toBe("abcd");
  });

  it("marks truncation when a later chunk arrives after the cap is already full", () => {
    const capBytes = 4;
    let output = appendCapped(EMPTY_CAPPED_OUTPUT, Buffer.from("abcd", "utf8"), capBytes);
    output = appendCapped(output, Buffer.from("x", "utf8"), capBytes);

    expect(output.bytes).toBe(4);
    expect(output.truncated).toBe(true);
    expect(decodeCapped(output)).toBe("abcd");
  });

  it("decodes a multi-byte UTF-8 character intact when it is split across two appended chunks", () => {
    // "é" (U+00E9) encodes to the 2-byte UTF-8 sequence 0xC3 0xA9. Feeding
    // each byte as a separate chunk reproduces a character split across a
    // stream `data` event boundary — decoding per-chunk (the old behavior)
    // would turn each half into a lone replacement character (U+FFFD).
    const multiByteCharacter = Buffer.from("é", "utf8");
    expect(multiByteCharacter.byteLength).toBe(2);
    const firstHalf = multiByteCharacter.subarray(0, 1);
    const secondHalf = multiByteCharacter.subarray(1, 2);

    let accumulated = EMPTY_CAPPED_OUTPUT;
    accumulated = appendCapped(accumulated, Buffer.from("prefix-", "utf8"), 16 * 1024);
    accumulated = appendCapped(accumulated, firstHalf, 16 * 1024);
    accumulated = appendCapped(accumulated, secondHalf, 16 * 1024);
    accumulated = appendCapped(accumulated, Buffer.from("-suffix", "utf8"), 16 * 1024);

    const decoded = decodeCapped(accumulated);

    expect(decoded).toBe("prefix-é-suffix");
    expect(decoded).not.toContain("�");
    expect(accumulated.truncated).toBe(false);
  });
});

describe("decodeCappedText", () => {
  it("drops an incomplete last line when the cap cut mid-line", () => {
    let output = EMPTY_CAPPED_OUTPUT;
    output = appendCapped(output, Buffer.from("complete-line\npartial", "utf8"), 20);

    expect(output.truncated).toBe(true);
    const decoded = decodeCappedText(output, { dropIncompleteLastLine: true, trim: "end" });
    expect(decoded.truncated).toBe(true);
    expect(decoded.text).toBe("complete-line");
  });

  it("keeps the last line when output was not truncated", () => {
    const output = appendCapped(EMPTY_CAPPED_OUTPUT, Buffer.from("only-line", "utf8"), 64);
    const decoded = decodeCappedText(output, { dropIncompleteLastLine: true });
    expect(decoded.truncated).toBe(false);
    expect(decoded.text).toBe("only-line");
  });
});

describe("formatRedactedCappedStream", () => {
  const collected = (text: string, truncated = false): CappedOutput => ({
    chunks: [Buffer.from(text, "utf8")],
    bytes: Buffer.byteLength(text),
    truncated,
  });
  const privateKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAkeybodyfirstline",
    "a2V5Ym9keXNlY29uZGxpbmU=",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  it("recognizes a private key whose end lies past the cap", () => {
    const text = `start\n${privateKey}\nafter\n`;
    const capBytes = text.indexOf("a2V5") + 4;
    const formatted = formatRedactedCappedStream(collected(text), "stdout", capBytes, []);
    expect(formatted).not.toContain("keybody");
    expect(formatted).not.toContain("a2V5");
    expect(formatted).toContain("[redacted:private-key]");
    expect(formatted).toContain("[truncated: stdout exceeded");
  });

  it("leaves out a secret line the cap would split, and keeps a plain line's prefix", () => {
    const secretText = "ok\nDB_PASSWORD=hunter2hunter2\n";
    const secretCap = "ok\nDB_PASSWORD=hunt".length;
    const secret = formatRedactedCappedStream(collected(secretText), "stdout", secretCap, []);
    expect(secret).not.toContain("hunt");
    expect(secret.startsWith("ok\n[truncated:")).toBe(true);

    const plain = formatRedactedCappedStream(collected("ok\nplain words\n"), "stdout", 8, []);
    expect(plain.startsWith("ok\nplain\n[truncated:")).toBe(true);
  });

  it("returns the whole redacted output under the cap without a notice", () => {
    const known = [{ name: "llm.test.api_key", value: "k9-capped-known-0123" }];
    const formatted = formatRedactedCappedStream(
      collected("key=k9-capped-known-0123\n"),
      "stderr",
      1024,
      known,
    );
    expect(formatted).toBe("key=[redacted:llm.test.api_key]");
  });
});
