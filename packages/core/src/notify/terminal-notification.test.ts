import { describe, expect, test } from "bun:test";
import {
  encodeOsc777,
  encodeOsc9,
  encodeOsc99,
  encodeTerminalNotification,
  MAX_TERMINAL_NOTIFICATION_BODY_CODE_POINTS,
  MAX_TERMINAL_NOTIFICATION_TITLE_CODE_POINTS,
  resolveTerminalNotificationSetting,
  selectTerminalNotificationProtocol,
  TERMINAL_NOTIFICATIONS_ENV_VAR,
} from "./terminal-notification";

const ESC = "\u001b";
const BEL = "\u0007";
const KITTY_BYTES_PER_CHUNK = 2048;

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function decodeKittyPayload(sequence: string): string {
  const payload = sequence.slice(sequence.lastIndexOf(";") + 1, -`${ESC}\\`.length);
  return Buffer.from(payload, "base64").toString("utf8");
}

describe("selectTerminalNotificationProtocol", () => {
  const cases: readonly [string, NodeJS.ProcessEnv, string | undefined][] = [
    ["kitty window", { KITTY_WINDOW_ID: "1" }, "osc99"],
    ["kitty TERM", { TERM: "xterm-kitty" }, "osc99"],
    ["Ghostty", { TERM_PROGRAM: "ghostty" }, "osc777"],
    ["WezTerm", { TERM_PROGRAM: "WezTerm" }, "osc777"],
    ["Warp", { TERM_PROGRAM: "WarpTerminal" }, "osc777"],
    ["iTerm2", { TERM_PROGRAM: "iTerm.app" }, "osc9"],
    ["iTerm2 over SSH", { LC_TERMINAL: "iTerm2" }, "osc9"],
    ["Apple Terminal", { TERM_PROGRAM: "Apple_Terminal" }, undefined],
    ["VTE", { VTE_VERSION: "7600" }, undefined],
    ["VS Code", { TERM_PROGRAM: "vscode" }, undefined],
    ["nothing", {}, undefined],
  ];

  for (const [label, env, expected] of cases) {
    test(`auto: ${label}`, () => {
      expect(selectTerminalNotificationProtocol(env, "auto")).toBe(
        expected as ReturnType<typeof selectTerminalNotificationProtocol>,
      );
    });
  }

  test("a forced protocol wins over detection", () => {
    expect(selectTerminalNotificationProtocol({ TERM_PROGRAM: "ghostty" }, "osc9")).toBe("osc9");
    expect(selectTerminalNotificationProtocol({}, "osc99")).toBe("osc99");
  });

  test("off never selects one", () => {
    expect(selectTerminalNotificationProtocol({ KITTY_WINDOW_ID: "1" }, "off")).toBeUndefined();
  });

  test("GNU screen never selects one, even when forced", () => {
    expect(
      selectTerminalNotificationProtocol({ STY: "1.pts", TERM_PROGRAM: "ghostty" }, "auto"),
    ).toBeUndefined();
    expect(selectTerminalNotificationProtocol({ STY: "1.pts" }, "osc777")).toBeUndefined();
  });
});

describe("resolveTerminalNotificationSetting", () => {
  test("the environment wins over the config", () => {
    expect(
      resolveTerminalNotificationSetting({ [TERMINAL_NOTIFICATIONS_ENV_VAR]: "OSC777" }, "off"),
    ).toBe("osc777");
  });

  test("an unknown environment value is ignored", () => {
    expect(
      resolveTerminalNotificationSetting({ [TERMINAL_NOTIFICATIONS_ENV_VAR]: "yes" }, "osc9"),
    ).toBe("osc9");
  });

  test("defaults to auto", () => {
    expect(resolveTerminalNotificationSetting({}, undefined)).toBe("auto");
  });
});

describe("encoders", () => {
  test("OSC 99 sends the title with d=0, then the body with d=1, both base64", () => {
    expect(encodeOsc99({ title: "Jazz", body: "Done" }, "n1")).toEqual([
      `${ESC}]99;i=n1:d=0:e=1:f=${base64("jazz")}:p=title;${base64("Jazz")}${ESC}\\`,
      `${ESC}]99;i=n1:d=1:e=1:p=body;${base64("Done")}${ESC}\\`,
    ]);
  });

  test("OSC 99 without a body is one finished chunk", () => {
    expect(encodeOsc99({ title: "Jazz", body: "" }, "n1")).toEqual([
      `${ESC}]99;i=n1:d=1:e=1:f=${base64("jazz")}:p=title;${base64("Jazz")}${ESC}\\`,
    ]);
  });

  test("OSC 99 carries unicode and semicolons through base64", () => {
    const [, bodyChunk] = encodeOsc99({ title: "🎷 Jazz", body: "café; 完成 ✅" }, "n1");
    expect(decodeKittyPayload(bodyChunk ?? "")).toBe("café; 完成 ✅");
  });

  test("OSC 777 is notify;title;body terminated by BEL", () => {
    expect(encodeOsc777({ title: "Jazz", body: "Done" })).toBe(`${ESC}]777;notify;Jazz;Done${BEL}`);
  });

  test("OSC 9 joins title and body", () => {
    expect(encodeOsc9({ title: "Jazz", body: "Done" })).toBe(`${ESC}]9;Jazz: Done${BEL}`);
    expect(encodeOsc9({ title: "", body: "Done" })).toBe(`${ESC}]9;Done${BEL}`);
  });

  test("ESC, BEL and newlines cannot end the sequence early", () => {
    const sequence = encodeOsc777({ title: `a${ESC}]0;x${BEL}b`, body: "line\nnext\r\u009bz" });
    expect(sequence).toBe(`${ESC}]777;notify;a ]0x b;line next z${BEL}`);
    // eslint-disable-next-line no-control-regex
    expect(sequence.slice(1, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("semicolons are removed from OSC 777 and OSC 9 fields", () => {
    expect(encodeOsc777({ title: "a;b", body: "c;d" })).toBe(`${ESC}]777;notify;ab;cd${BEL}`);
    expect(encodeOsc9({ title: "4;1", body: "x" })).toBe(`${ESC}]9;41: x${BEL}`);
  });

  test("title and body are bounded, and every OSC 99 chunk fits kitty's limit", () => {
    const longTitle = "t".repeat(MAX_TERMINAL_NOTIFICATION_TITLE_CODE_POINTS * 2);
    const longBody = "🎷".repeat(MAX_TERMINAL_NOTIFICATION_BODY_CODE_POINTS * 2);
    const [titleChunk, bodyChunk] = encodeOsc99({ title: longTitle, body: longBody }, "n1");
    const title = decodeKittyPayload(titleChunk ?? "");
    const body = decodeKittyPayload(bodyChunk ?? "");
    expect(Array.from(title)).toHaveLength(MAX_TERMINAL_NOTIFICATION_TITLE_CODE_POINTS);
    expect(Array.from(body)).toHaveLength(MAX_TERMINAL_NOTIFICATION_BODY_CODE_POINTS);
    expect(body.endsWith("🎷…")).toBe(true);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(KITTY_BYTES_PER_CHUNK);
  });
});

describe("encodeTerminalNotification", () => {
  test("writes the sequence as is outside tmux", () => {
    expect(
      encodeTerminalNotification({ title: "Jazz", body: "Done" }, "osc777", { id: "n1", env: {} }),
    ).toBe(`${ESC}]777;notify;Jazz;Done${BEL}`);
  });

  test("wraps each sequence in tmux passthrough with ESC doubled", () => {
    const env = { TMUX: "/tmp/tmux-501/default,1,0" };
    expect(
      encodeTerminalNotification({ title: "Jazz", body: "Done" }, "osc9", { id: "n1", env }),
    ).toBe(`${ESC}Ptmux;${ESC}${ESC}]9;Jazz: Done${BEL}${ESC}\\`);
    const kitty = encodeTerminalNotification({ title: "Jazz", body: "Done" }, "osc99", {
      id: "n1",
      env,
    });
    expect(kitty.split(`${ESC}Ptmux;`)).toHaveLength(3);
    expect(kitty.startsWith(`${ESC}Ptmux;${ESC}${ESC}]99;i=n1:d=0`)).toBe(true);
  });
});
