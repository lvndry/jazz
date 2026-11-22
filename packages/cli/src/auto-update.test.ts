import { describe, expect, test } from "bun:test";
import {
  buildUpdaterEnvironment,
  shouldInstallInBackground,
  updateBannerDestination,
} from "./auto-update";

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
  test("installs a patch release for an installed Jazz", () => {
    expect(shouldInstallInBackground({}, false, "0.17.6", "0.17.7")).toBe(true);
  });

  test("leaves a source checkout alone", () => {
    expect(shouldInstallInBackground({}, true, "0.17.6", "0.17.7")).toBe(false);
  });

  test("honors the opt-out", () => {
    expect(
      shouldInstallInBackground({ JAZZ_DISABLE_AUTO_UPDATE: "1" }, false, "0.17.6", "0.17.7"),
    ).toBe(false);
  });

  test("leaves a minor release to the user", () => {
    expect(shouldInstallInBackground({}, false, "0.17.6", "0.18.0")).toBe(false);
  });
});

describe("buildUpdaterEnvironment", () => {
  test("keeps what locating and fetching the package needs", () => {
    const updaterEnvironment = buildUpdaterEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/home/user/.config",
      HTTPS_PROXY: "http://proxy:8080",
      JAZZ_HOME: "/home/user/.jazz",
    });
    expect(updaterEnvironment).toEqual({
      JAZZ_DISABLE_UPDATE_CHECK: "1",
      PATH: "/usr/bin",
      HOME: "/home/user",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/home/user/.config",
      HTTPS_PROXY: "http://proxy:8080",
      JAZZ_HOME: "/home/user/.jazz",
    });
  });

  test("drops credentials", () => {
    const updaterEnvironment = buildUpdaterEnvironment({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      NPM_TOKEN: "npm-secret",
      GITHUB_TOKEN: "gh-secret",
    });
    expect(Object.keys(updaterEnvironment).sort()).toEqual(["JAZZ_DISABLE_UPDATE_CHECK", "PATH"]);
  });
});
