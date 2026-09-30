import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { isProcessAlive } from "@/core/utils/process";
import { CuaDriver } from "./cua-driver";
import { DriverError } from "./driver";

const fakeServer = path.join(import.meta.dir, "fake-cua-server.ts");

const opened: CuaDriver[] = [];

async function open(environment: Record<string, string | undefined> = {}): Promise<CuaDriver> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    const driver = await CuaDriver.open({ executablePath: process.execPath, args: [fakeServer] });
    opened.push(driver);
    return driver;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((driver) => driver.close()));
});

describe("CuaDriver over MCP", () => {
  test("starts the driver, reports its version, and answers discovery calls", async () => {
    const driver = await open();

    expect(driver.version).toBe("0.0.1");
    expect(driver.pid).not.toBeNull();
    const apps = await driver.listApps();
    expect(apps[0]).toMatchObject({ name: "Notes", bundleId: "com.apple.Notes", running: true });
    const windows = await driver.listWindows(500);
    expect(windows[0]).toMatchObject({ windowId: 7, title: "Note", pid: 500 });
  });

  test("reads a window's elements and delivers an action", async () => {
    const driver = await open();

    const state = await driver.windowState(
      { pid: 500, windowId: 7 },
      { maxElements: 10, maxDepth: 3 },
    );
    expect(state.elements[0]).toMatchObject({ role: "AXButton", token: "t0", label: "New" });

    const result = await driver.act({
      kind: "click",
      target: { pid: 500, windowId: 7 },
      elementToken: "t0",
      delivery: "background",
    });
    expect(result).toMatchObject({ effect: "confirmed", summary: "clicked" });
  });

  test("turns a driver error into a driver error", async () => {
    const driver = await open();

    await expect(
      driver.act({
        kind: "key",
        target: { pid: 500, windowId: 7 },
        key: "Return",
        modifiers: [],
        delivery: "background",
      }),
    ).rejects.toBeInstanceOf(DriverError);
  });

  test("refuses a driver that lacks a tool computer use needs", async () => {
    await expect(open({ FAKE_CUA_OMIT_TOOL: "press_key" })).rejects.toThrow(
      "does not offer the tools computer use needs: press_key",
    );
  });

  test("forces standard mode and drops a manifest inherited from the surrounding shell", async () => {
    const driver = await open({
      FAKE_CUA_ECHO_ENV: "1",
      CUA_DRIVER_PERMISSION_MODE: "unrestricted",
      CUA_DRIVER_CAPABILITY_MANIFEST_FILE: "/tmp/manifest.yaml",
    });

    const [app] = await driver.listApps();

    expect(app?.name).toBe("mode=standard;manifest=unset");
  });

  test("stops the driver process when it is closed", async () => {
    const driver = await open();
    const pid = driver.pid ?? -1;
    expect(isProcessAlive(pid)).toBe(true);

    await driver.close();
    await Bun.sleep(100);

    expect(isProcessAlive(pid)).toBe(false);
  });

  test("reports a driver that cannot start", async () => {
    await expect(
      CuaDriver.open({ executablePath: "/nonexistent/cua-driver", args: ["mcp"] }),
    ).rejects.toThrow("Could not start the computer-use driver");
  });
});
