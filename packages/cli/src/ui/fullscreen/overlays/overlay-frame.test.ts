import { describe, expect, it } from "bun:test";
import { overlayReservedRows, overlayWidth, placeOverlay } from "./overlay-frame";

describe("where an overlay card sits", () => {
  it("docks above the footer on the prose column, on a terminal wide and tall enough", () => {
    const viewport = { width: 120, height: 34 };
    const placement = placeOverlay(viewport, overlayWidth(viewport), 10);
    expect(placement).toEqual({ fullscreen: false, width: 96, height: 10, left: 0, top: 23 });
    expect(overlayReservedRows(placement)).toBe(11);
  });

  it("spans a narrow terminal instead of taking the whole screen", () => {
    const viewport = { width: 80, height: 24 };
    const placement = placeOverlay(viewport, overlayWidth(viewport), 8);
    expect(placement).toEqual({ fullscreen: false, width: 80, height: 8, left: 0, top: 15 });
  });

  it("takes the whole screen only when the terminal is too short for a docked card", () => {
    const viewport = { width: 120, height: 18 };
    const placement = placeOverlay(viewport, overlayWidth(viewport), 8);
    expect(placement).toEqual({ fullscreen: true, width: 120, height: 18, left: 0, top: 0 });
    expect(overlayReservedRows(placement)).toBe(18);
  });

  it("never grows past the rows above the footer", () => {
    const viewport = { width: 120, height: 30 };
    expect(placeOverlay(viewport, overlayWidth(viewport), 99)).toMatchObject({
      height: 29,
      top: 0,
    });
  });
});
