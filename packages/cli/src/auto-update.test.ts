import { describe, expect, test } from "bun:test";
import { updateBannerDestination } from "./auto-update";

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
