import { report } from "@jazz/core/interfaces/terminal";
import { describe, expect, it } from "bun:test";
import { getGlyphs } from "./glyphs";
import { REPORT_METER_CELLS, reportLines, reportPlainText } from "./report-layout";

const glyphs = getGlyphs();

describe("reportLines", () => {
  it("puts the command's name in a label column and hangs every other row under the values", () => {
    const text = reportPlainText(
      report("theme", [
        { kind: "field", key: "current", value: "jazz, dark" },
        { kind: "field", key: "saved as", value: "ui.theme" },
      ]),
      glyphs,
    );
    expect(text.split("\n")).toEqual([
      "theme     current    jazz, dark",
      "          saved as   ui.theme",
    ]);
  });

  it("aligns keys within a run and right-aligns a run of numbers", () => {
    const lines = reportPlainText(
      report("cost", [
        { kind: "field", key: "input", value: "1,204" },
        { kind: "field", key: "output", value: "98" },
      ]),
      glyphs,
    ).split("\n");
    expect(lines[0]).toBe("cost      input    1,204");
    expect(lines[1]).toBe("          output      98");
  });

  it("left-aligns a run with any non-numeric value", () => {
    const lines = reportPlainText(
      report("model", [
        { kind: "field", key: "tokens", value: "12" },
        { kind: "field", key: "model", value: "openai/gpt-5.6" },
      ]),
      glyphs,
    ).split("\n");
    expect(lines[0]).toBe("model     tokens   12");
  });

  it("widens the label column for a long command name", () => {
    const [first] = reportLines(report("workflows", [{ kind: "text", text: "none" }]), glyphs);
    expect(first?.segments[0]?.text).toBe("workflows   ");
  });

  it("marks items only when some item carries a marker, and aligns their details", () => {
    const lines = reportPlainText(
      report("theme", [
        { kind: "item", name: "jazz", detail: "dark, light", marker: "current" },
        { kind: "item", name: "catppuccin", detail: "dark, light" },
      ]),
      glyphs,
    ).split("\n");
    expect(lines[0]).toBe(`theme     ${glyphs.arrow} jazz         dark, light`);
    expect(lines[1]).toBe("            catppuccin   dark, light");
  });

  it("draws a meter whose lit cells follow the share used", () => {
    const [line] = reportLines(
      report("context", [{ kind: "meter", used: 50, total: 100, caption: "50 of 100" }]),
      glyphs,
    );
    const lit = line?.segments.find((segment) => segment.role === "accent");
    const unlit = line?.segments.find((segment) => segment.role === "border");
    expect([...(lit?.text ?? "")].length).toBe(REPORT_METER_CELLS / 2);
    expect([...(unlit?.text ?? "")].length).toBe(REPORT_METER_CELLS / 2);
    expect(line?.segments.at(-1)?.text).toBe("  50%");
  });

  it("warms the meter as the window fills", () => {
    const [line] = reportLines(
      report("context", [{ kind: "meter", used: 95, total: 100, caption: "95 of 100" }]),
      glyphs,
    );
    expect(line?.segments.some((segment) => segment.role === "error")).toBe(true);
  });

  it("sets the note apart after one blank row, muted", () => {
    const lines = reportLines(
      report("help", [{ kind: "text", text: "a" }], "Run /help <command> for more."),
      glyphs,
    );
    expect(lines.map((line) => line.segments.map((segment) => segment.text).join(""))).toEqual([
      "help      a",
      "",
      "Run /help <command> for more.",
    ]);
    expect(lines[2]?.segments[0]?.role).toBe("muted");
  });

  it("hangs a wrapped field value under its own value column, not under the label", () => {
    const text = reportPlainText(
      report("info", [
        { kind: "field", key: "model", value: "openai/gpt-5.6" },
        { kind: "field", key: "session log", value: `/very/long/${"segment/".repeat(8)}file.log` },
      ]),
      glyphs,
      50,
    ).split("\n");
    const valueColumn = text[0]?.indexOf("openai") ?? -1;
    expect(text[1]?.indexOf("/very")).toBe(valueColumn);
    for (const continuation of text.slice(2)) {
      expect(continuation.search(/\S/)).toBe(valueColumn);
    }
    for (const line of text) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  it("still names the command when a report has no rows", () => {
    expect(reportPlainText(report("clear", []), glyphs)).toBe("clear");
  });
});
