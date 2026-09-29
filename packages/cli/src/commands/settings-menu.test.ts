import type { AppConfig } from "@jazz/core/types/config";
import { describe, expect, it } from "bun:test";
import { settingsMenuOptions } from "./config-wizard";

function config(overrides: Partial<AppConfig>): AppConfig {
  return { logging: { level: "info", format: "plain" }, ...overrides } as AppConfig;
}

function hintOf(
  options: ReturnType<typeof settingsMenuOptions>,
  value: string,
): string | undefined {
  return options.find((option) => option.value === value)?.hint;
}

describe("settingsMenuOptions", () => {
  it("shows each setting's current value beside it", () => {
    const options = settingsMenuOptions(
      config({
        llm: { openai: { api_key: "sk-test" } } as NonNullable<AppConfig["llm"]>,
        notifications: { enabled: true },
        daemon: { goals: { dailyCostUSD: 20 } },
        ui: { theme: "jazz:light" },
        logging: { level: "warn", format: "plain" },
      }),
    );
    expect(hintOf(options, "llm-providers")).toBe("1 ready");
    expect(hintOf(options, "notifications")).toBe("on");
    expect(hintOf(options, "spend-limits")).toBe("$20 / day");
    expect(hintOf(options, "output-display")).toBe("jazz:light");
    expect(hintOf(options, "logging")).toBe("warn");
    expect(options.at(-1)).toEqual({ label: "Back", value: "back" });
    expect(hintOf(options, "private-hosts")).toBe("none allowed");
    expect(hintOf(options, "trusted-hosts")).toBe("none trusted");
    expect(hintOf(options, "tainted-egress")).toBe("allow all");
  });

  it("says plainly when nothing is set up yet", () => {
    const previous = { ...process.env };
    for (const name of Object.keys(process.env)) {
      if (name.endsWith("_API_KEY")) delete process.env[name];
    }
    try {
      const options = settingsMenuOptions(config({}));
      expect(hintOf(options, "llm-providers")).toBe("none has a key yet");
      expect(hintOf(options, "web-search")).toBe("no key saved");
      expect(hintOf(options, "notifications")).toBe("not set up");
      expect(hintOf(options, "spend-limits")).toBe("no limit");
    } finally {
      Object.assign(process.env, previous);
    }
  });
});
