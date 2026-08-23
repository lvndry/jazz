import { describe, expect, test } from "bun:test";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import type { AppConfig } from "@/core/types/config";
import { resolveDisplayConfig } from "./display-config";

const baseConfig: AppConfig = {
  storage: { type: "file", path: "/tmp" },
  logging: { level: "info", format: "plain" },
};

describe("resolveDisplayConfig", () => {
  test("defaults collapseReasoning to true", () => {
    const display = resolveDisplayConfig(baseConfig);
    expect(display.collapseReasoning).toBe(true);
    expect(display.collapseReasoning).toBe(DEFAULT_DISPLAY_CONFIG.collapseReasoning);
  });

  test("honors output.collapseReasoning false", () => {
    const display = resolveDisplayConfig({
      ...baseConfig,
      output: { collapseReasoning: false },
    });
    expect(display.collapseReasoning).toBe(false);
  });

  test("coerces the string false from jazz config set", () => {
    const display = resolveDisplayConfig({
      ...baseConfig,
      output: { collapseReasoning: "false" as unknown as boolean },
    });
    expect(display.collapseReasoning).toBe(false);
  });
});
