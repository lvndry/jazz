import { describe, expect, test } from "bun:test";
import { shouldInstallInBackground, updateBannerDestination } from "./auto-update";

describe("updateBannerDestination", () => {
  test("the interactive UI shows the notice itself", () => {
    expect(updateBannerDestination(true, false)).toBe("terminal");
  });

  test("a plain terminal writes it to stderr only when stderr is a terminal", () => {
    expect(updateBannerDestination(false, true)).toBe("stderr");
    expect(updateBannerDestination(false, false)).toBe("none");
    expect(updateBannerDestination(false, undefined)).toBe("none");
  });
});

describe("shouldInstallInBackground", () => {
  test("installs for an installed Jazz", () => {
    expect(shouldInstallInBackground({}, false)).toBe(true);
  });

  test("leaves a source checkout alone", () => {
    expect(shouldInstallInBackground({}, true)).toBe(false);
  });

  test("honors the opt-out", () => {
    expect(shouldInstallInBackground({ JAZZ_DISABLE_AUTO_UPDATE: "1" }, false)).toBe(false);
  });
});
