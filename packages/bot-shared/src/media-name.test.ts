import { describe, expect, test } from "bun:test";
import { inboundMediaFileName } from "./media-name";

describe("inboundMediaFileName", () => {
  test("keeps an ordinary extension from the file name, then the MIME type", () => {
    expect(inboundMediaFileName("ABC123", "report.PDF", "application/pdf")).toBe("ABC123.pdf");
    expect(inboundMediaFileName("ABC123", undefined, "audio/ogg; codecs=opus")).toBe("ABC123.ogg");
    expect(inboundMediaFileName("ABC123", "noextension", undefined)).toBe("ABC123.bin");
  });

  test("never lets the sender's name or id climb out of the directory", () => {
    const name = inboundMediaFileName("../../x", "photo./../../../etc/cron.d/job", "image/jpeg");
    expect(name).not.toContain("/");
    expect(name).toBe("______x.jpeg");
  });
});
