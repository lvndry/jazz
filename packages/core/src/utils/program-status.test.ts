import { beforeEach, describe, expect, test } from "bun:test";
import {
  encodeProgramStatus,
  notifyTerminal,
  programStatusEnabled,
  reportProgramCwd,
  resetProgramStatusCache,
  resetTerminalNotificationCache,
  reportProgramStatus,
} from "./program-status";

describe("encodeProgramStatus", () => {
  const ESC = "\u001b";
  const ST = "\u001b\\";

  test("frames a bare state report", () => {
    expect(encodeProgramStatus({ state: "working" })).toBe(
      `${ESC}]7501 ; state=working:app=jazz${ST}`,
    );
  });

  test("blocked carries its kind", () => {
    expect(encodeProgramStatus({ state: "blocked", kind: "permission" })).toBe(
      `${ESC}]7501 ; state=blocked:app=jazz:kind=permission${ST}`,
    );
  });

  test("msg is UTF-8 base64", () => {
    const out = encodeProgramStatus({
      state: "blocked",
      kind: "question",
      msg: "which color? émoji 🎨",
    });
    const expected = Buffer.from("which color? émoji 🎨", "utf8").toString("base64");
    expect(out).toBe(`${ESC}]7501 ; state=blocked:app=jazz:kind=question:msg=${expected}${ST}`);
  });

  test("strips C0, DEL and C1 controls from the message", () => {
    // SOH, ESC, DEL and C1 (0x80) are dropped; a literal `[` is an ordinary character.
    const out = encodeProgramStatus({ state: "working", msg: "a\u0001b\u001b[c\u007fd\u0080e" });
    const decoded = Buffer.from(out.slice(out.indexOf("msg=") + 4, -2), "base64").toString("utf8");
    expect(decoded).toBe("ab[cde");
  });

  test("truncates the message to 2048 decoded characters", () => {
    const out = encodeProgramStatus({ state: "working", msg: "x".repeat(3000) });
    const expected = Buffer.from("x".repeat(2048), "utf8").toString("base64");
    expect(out).toContain(`msg=${expected}`);
  });

  test("caps the whole report at 4096 bytes by dropping the message", () => {
    const out = encodeProgramStatus({ state: "working", msg: "é".repeat(2048) });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4096);
    expect(out).not.toContain("msg=");
    expect(out).toContain("state=working:app=jazz");
  });

  test("keeps state and kind when the message is dropped", () => {
    const out = encodeProgramStatus({
      state: "blocked",
      kind: "permission",
      msg: "é".repeat(2048),
    });
    expect(out).toContain("state=blocked:app=jazz:kind=permission");
    expect(out).not.toContain("msg=");
  });

  test("title is base64 and id is the raw record path", () => {
    const out = encodeProgramStatus({ state: "working", id: "subagent/abc", title: "team lead" });
    const expectedTitle = Buffer.from("team lead", "utf8").toString("base64");
    expect(out).toContain(`:title=${expectedTitle}:id=subagent/abc`);
  });

  test("an id outside the grammar is omitted, not mangled", () => {
    const out = encodeProgramStatus({ state: "working", id: "not an id" });
    expect(out).not.toContain("id=");
    expect(out).toContain("state=working:app=jazz");
  });
});

describe("programStatusEnabled", () => {
  test("defaults on", () => {
    expect(programStatusEnabled({})).toBe(true);
  });
  test("off values disable, case-insensitive", () => {
    expect(programStatusEnabled({ JAZZ_OSC7501: "0" })).toBe(false);
    expect(programStatusEnabled({ JAZZ_OSC7501: "false" })).toBe(false);
    expect(programStatusEnabled({ JAZZ_OSC7501: "OFF" })).toBe(false);
  });
  test("other values leave it on", () => {
    expect(programStatusEnabled({ JAZZ_OSC7501: "1" })).toBe(true);
  });
});

describe("reportProgramStatus", () => {
  beforeEach(() => {
    resetProgramStatusCache();
    resetTerminalNotificationCache();
  });

  test("disabled env never writes", () => {
    const spy = spyStdoutWrites();
    try {
      expect(reportProgramStatus({ state: "working" }, { JAZZ_OSC7501: "0" })).toBe(false);
      expect(spy.writes).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test("deduplicates an identical consecutive report", () => {
    const spy = spyStdoutWrites();
    const env = { TERM_PROGRAM: "ghostty" };
    try {
      expect(reportProgramStatus({ state: "working" }, env)).toBe(true);
      expect(spy.writes).toBe(1);
      expect(reportProgramStatus({ state: "working" }, env)).toBe(false);
      expect(spy.writes).toBe(1);
      // A fresh blocked report writes the status plus one notification ping.
      expect(reportProgramStatus({ state: "blocked", kind: "permission" }, env)).toBe(true);
      expect(spy.writes).toBe(3);
      expect(reportProgramStatus({ state: "blocked", kind: "permission" }, env)).toBe(false);
      expect(spy.writes).toBe(3);
    } finally {
      spy.restore();
    }
  });

  test("writes the sequence to stdout when that is the only terminal", () => {
    const spy = spyStdoutWrites();
    try {
      expect(reportProgramStatus({ state: "done" })).toBe(true);
      expect(spy.last()).toContain("state=done:app=jazz");
    } finally {
      spy.restore();
    }
  });
});

/**
 * Capture what writeControllingTerminal falls back to: its stdout write, which
 * only happens when stdout is itself a TTY. In tests, /dev/tty is unwritable so
 * this fallback is the path under test.
 */
function spyStdoutWrites() {
  const originalIsTTY = process.stdout.isTTY;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const sequences: string[] = [];
  process.stdout.isTTY = true;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    sequences.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    get writes() {
      return sequences.length;
    },
    get sequences() {
      return sequences;
    },
    last: () => sequences.at(-1) ?? "",
    restore: () => {
      process.stdout.isTTY = originalIsTTY;
      process.stdout.write = originalWrite;
    },
  };
}

describe("notifyTerminal", () => {
  beforeEach(() => resetTerminalNotificationCache());

  test("uses the terminal's detected protocol (ghostty: OSC 777 notify)", () => {
    const spy = spyStdoutWrites();
    try {
      expect(notifyTerminal("Jazz needs your approval", { TERM_PROGRAM: "ghostty" })).toBe(true);
      expect(spy.writes).toBe(1);
      expect(spy.last()).toContain("\u001b]777;notify;Jazz needs your approval;\u0007");
    } finally {
      spy.restore();
    }
  });

  test("iTerm2 gets OSC 9", () => {
    const spy = spyStdoutWrites();
    try {
      expect(notifyTerminal("Jazz: which color?", { TERM_PROGRAM: "iTerm.app" })).toBe(true);
      expect(spy.last()).toContain("\u001b]9;Jazz: which color?\u0007");
    } finally {
      spy.restore();
    }
  });

  test("an unknown terminal gets no sequence", () => {
    const spy = spyStdoutWrites();
    try {
      expect(notifyTerminal("x", {})).toBe(false);
      expect(spy.writes).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test("off setting and screen never write", () => {
    const spy = spyStdoutWrites();
    try {
      expect(
        notifyTerminal("x", { TERM_PROGRAM: "ghostty", JAZZ_NOTIFICATIONS_TERMINAL: "off" }),
      ).toBe(false);
      expect(notifyTerminal("x", { TERM_PROGRAM: "ghostty", STY: "1.pts" })).toBe(false);
      expect(spy.writes).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test("dedups the same title within the window", () => {
    const spy = spyStdoutWrites();
    try {
      notifyTerminal("Jazz needs your approval", { TERM_PROGRAM: "ghostty" });
      expect(notifyTerminal("Jazz needs your approval", { TERM_PROGRAM: "ghostty" })).toBe(false);
      expect(spy.writes).toBe(1);
      expect(notifyTerminal("Jazz has a question", { TERM_PROGRAM: "ghostty" })).toBe(true);
    } finally {
      spy.restore();
    }
  });
});

describe("reportProgramCwd", () => {
  test("encodes the path as a file URL form", () => {
    const spy = spyStdoutWrites();
    try {
      expect(reportProgramCwd("/Users/lvndry/github/jazz")).toBe(true);
      expect(spy.last()).toBe("\u001b]7;/Users/lvndry/github/jazz\u001b\\");
    } finally {
      spy.restore();
    }
  });

  test("percent-encodes spaces in the path", () => {
    const spy = spyStdoutWrites();
    try {
      reportProgramCwd("/Users/lvndry/My Projects");
      expect(spy.last()).toBe("\u001b]7;/Users/lvndry/My%20Projects\u001b\\");
    } finally {
      spy.restore();
    }
  });

  test("disabled env never writes", () => {
    const spy = spyStdoutWrites();
    try {
      expect(reportProgramCwd("/tmp", { JAZZ_OSC_CWD: "0" })).toBe(false);
      expect(spy.writes).toBe(0);
    } finally {
      spy.restore();
    }
  });
});
