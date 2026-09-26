import { describe, expect, it } from "bun:test";
import { joinConfigPath, splitConfigPath } from "./config-path";

describe("splitConfigPath", () => {
  it("splits a plain dotted path", () => {
    expect(splitConfigPath("llm.openai.api_key")).toEqual(["llm", "openai", "api_key"]);
  });

  it("keeps the dots inside a quoted segment", () => {
    expect(
      splitConfigPath(
        'llm.capabilityOverrides.nvidia."deepseek-ai/deepseek-v4.1-flash".supportsTools',
      ),
    ).toEqual([
      "llm",
      "capabilityOverrides",
      "nvidia",
      "deepseek-ai/deepseek-v4.1-flash",
      "supportsTools",
    ]);
    expect(splitConfigPath('mcpServers."com.example.mcp"')).toEqual([
      "mcpServers",
      "com.example.mcp",
    ]);
  });

  it("rejects malformed paths", () => {
    for (const path of [
      "",
      "llm.",
      ".llm",
      "llm..openai",
      'llm."unterminated',
      'llm."quoted"trailing',
      'llm.""',
      'llm.half"quoted',
    ]) {
      expect(splitConfigPath(path)).toBeUndefined();
    }
  });
});

describe("joinConfigPath", () => {
  it("quotes only the segments that contain a dot", () => {
    expect(joinConfigPath(["llm", "openai", "api_key"])).toBe("llm.openai.api_key");
    expect(joinConfigPath(["llm", "capabilityOverrides", "nvidia", "deepseek-v4.1-flash"])).toBe(
      'llm.capabilityOverrides.nvidia."deepseek-v4.1-flash"',
    );
  });

  it("round-trips through splitConfigPath", () => {
    const segments = ["llm", "capabilityOverrides", "vllm", "Qwen/Qwen3.5-8B", "supportsTools"];
    expect(splitConfigPath(joinConfigPath(segments))).toEqual(segments);
  });
});
