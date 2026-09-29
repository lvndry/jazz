import { describe, expect, it } from "bun:test";
import { MIN_HEIGHT, MIN_WIDTH } from "./fullscreen/types";
import { decideFullscreen } from "./terminal-capabilities";

const ENVIRONMENT = { TERM: "xterm-256color" };
const OUTPUT = { isTTY: true, columns: 100, rows: 24 };
const INPUT = { isTTY: true };

describe("decideFullscreen", () => {
  it("accepts a capable interactive terminal", () => {
    expect(decideFullscreen({}, ENVIRONMENT, OUTPUT, INPUT)).toEqual({
      fullscreen: true,
      width: 100,
      height: 24,
    });
  });

  it("starts the fullscreen interface at the compact floor", () => {
    expect(
      decideFullscreen({}, ENVIRONMENT, { ...OUTPUT, columns: MIN_WIDTH, rows: MIN_HEIGHT }, INPUT),
    ).toMatchObject({ fullscreen: true, width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it("rejects every environment that requires append-only output", () => {
    expect(decideFullscreen({}, { ...ENVIRONMENT, CI: "1" }, OUTPUT, INPUT).reason).toBe("ci");
    expect(decideFullscreen({}, { TERM: "dumb" }, OUTPUT, INPUT).reason).toBe("dumb-terminal");
    expect(decideFullscreen({}, { ...ENVIRONMENT, JAZZ_A11Y: "1" }, OUTPUT, INPUT).reason).toBe(
      "screen-reader",
    );
    expect(
      decideFullscreen({}, ENVIRONMENT, { ...OUTPUT, columns: MIN_WIDTH - 1 }, INPUT).reason,
    ).toBe("too-small");
    expect(
      decideFullscreen({}, ENVIRONMENT, { ...OUTPUT, rows: MIN_HEIGHT - 1 }, INPUT).reason,
    ).toBe("too-small");
    expect(decideFullscreen({}, ENVIRONMENT, OUTPUT, { isTTY: false }).reason).toBe("not-a-tty");
  });
});
