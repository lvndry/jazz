import { describe, expect, it } from "bun:test";
import {
  checkConfigWrite,
  formatConfigIssues,
  parseConfigFile,
  parseConfigInput,
  resolveConfigPath,
  validateEffectiveConfig,
} from "./config-schema";

const neverSecret = () => false;

describe("parseConfigFile", () => {
  it("keeps a valid file exactly as written", () => {
    const contents = {
      logging: { level: "debug" },
      llm: {
        streamIdleTimeoutMs: 600000,
        ollama: { base_url: "http://h:11434/api", keep_alive: "-1" },
      },
      output: { collapseReasoning: false, streaming: { enabled: "auto", textBufferMs: 0 } },
      mcpServers: { github: { enabled: false, trusted: true } },
      maxRetries: 0,
      maxCostUSD: 0.2,
      maxTokens: 200000,
      maxDurationMs: 1800000,
      workspaceMaxTotalBytesPerAgent: 1048576,
      scheduler: { mode: "in-process" },
      context: { warnThresholdRatio: 0.7, compactThresholdRatio: 0.8 },
      telemetry: { otlp: { signals: ["traces"], headers: { authorization: "Bearer x" } } },
      peers: [{ name: "sam", url: "https://sam.example", disclosure: "public" }],
      webhooks: [{ name: "deploy", agentId: "default", promptTemplate: "{{payload}}" }],
      daemon: { token: "file-fallback" },
    };

    const { config, issues } = parseConfigFile(contents);

    expect(issues).toEqual([]);
    expect(config).toEqual(contents as typeof config);
  });

  it("removes a mistyped value, keeps its siblings, and says what it wanted", () => {
    const { config, issues } = parseConfigFile({
      maxRetries: "5",
      output: { collapseReasoning: "false", mode: "raw" },
    });

    expect(config).toEqual({ output: { mode: "raw" } });
    expect(issues).toHaveLength(2);
    expect(issues).toContainEqual({
      kind: "invalid-value",
      path: "maxRetries",
      removed: "maxRetries",
      expected: "a whole number of 0 or more",
      actual: "5",
    });
    expect(issues).toContainEqual({
      kind: "invalid-value",
      path: "output.collapseReasoning",
      removed: "output.collapseReasoning",
      expected: "true or false",
      actual: "false",
    });
  });

  it("removes unknown keys at any depth, suggesting the setting a typo meant", () => {
    const { config, issues } = parseConfigFile({
      maxRetrys: 5,
      output: { colapseReasoning: false },
      theme: "dark",
    });

    expect(config).toEqual({ output: {} });
    expect(issues).toContainEqual({
      kind: "unknown-key",
      path: "maxRetrys",
      removed: "maxRetrys",
      suggestion: "maxRetries",
    });
    expect(issues).toContainEqual({
      kind: "unknown-key",
      path: "output.colapseReasoning",
      removed: "output.colapseReasoning",
      suggestion: "output.collapseReasoning",
    });
    expect(issues).toContainEqual({ kind: "unknown-key", path: "theme", removed: "theme" });
  });

  it("drops a broken list entry whole and keeps the valid ones", () => {
    const { config, issues } = parseConfigFile({
      webhooks: [
        { name: "a", agentId: "x", promptTemplate: "p" },
        { name: "b", agentId: "x" },
        { name: "c", agentId: "x", promptTemplate: "p", disclosure: "everything" },
        { name: "d", agentId: "x", promptTemplate: "p" },
      ],
    });

    expect(config.webhooks?.map((webhook) => webhook.name)).toEqual(["a", "d"]);
    expect(issues).toContainEqual({
      kind: "invalid-value",
      path: "webhooks[1].promptTemplate",
      removed: "webhooks[1]",
      expected: "text",
      actual: undefined,
    });
    expect(issues.map((issue) => issue.removed)).toContain("webhooks[2]");
  });

  it("reports a full server definition under mcpServers, which only holds overrides", () => {
    const { config, issues } = parseConfigFile({
      mcpServers: { github: { enabled: true, command: "npx" } },
    });

    expect(config).toEqual({ mcpServers: { github: { enabled: true } } });
    expect(issues).toEqual([
      {
        kind: "unknown-key",
        path: "mcpServers.github.command",
        removed: "mcpServers.github.command",
      },
    ]);
  });

  it("refuses values a reader would ignore or misuse", () => {
    const { issues } = parseConfigFile({
      maxRetries: -1,
      maxIterations: 2.5,
      maxCostUSD: 0,
      maxTokens: 0,
      llm: { streamIdleTimeoutMs: 0 },
      output: { streaming: { enabled: "sometimes" } },
      scheduler: { mode: "cron" },
    });

    const expectations = Object.fromEntries(
      issues.map((issue) => [issue.path, issue.kind === "invalid-value" && issue.expected]),
    );
    expect(expectations).toEqual({
      maxRetries: "a whole number of 0 or more",
      maxIterations: "a whole number greater than 0",
      maxCostUSD: "a number greater than 0",
      maxTokens: "a whole number greater than 0",
      "llm.streamIdleTimeoutMs": "a whole number greater than 0",
      "output.streaming.enabled": "true, false, or auto",
      "scheduler.mode": "auto or in-process",
    });
  });

  it("enforces context thresholds before readers can silently replace them", () => {
    const { issues } = parseConfigFile({
      context: { warnThresholdRatio: 0.9, compactThresholdRatio: 0.8 },
    });

    expect(issues).toContainEqual({
      kind: "invalid-value",
      path: "context.warnThresholdRatio",
      removed: "context.warnThresholdRatio",
      expected: "a number greater than 0 and less than 1",
      actual: 0.9,
    });
    expect(parseConfigFile({ context: { compactThresholdRatio: 0.95 } }).issues[0]).toMatchObject({
      path: "context.compactThresholdRatio",
      expected: "a number greater than 0 and less than 0.95",
    });
  });

  it("replaces a section that is not an object with nothing", () => {
    const { config, issues } = parseConfigFile({ llm: "ollama", maxRetries: 2 });

    expect(config).toEqual({ maxRetries: 2 });
    expect(issues).toHaveLength(1);
  });

  it("never mutates the file contents it was given", () => {
    const contents = { maxRetries: "5", webhooks: [{ name: "b" }] };
    const snapshot = structuredClone(contents);

    parseConfigFile(contents);

    expect(contents).toEqual(snapshot);
  });
});

describe("formatConfigIssues", () => {
  it("says nothing when nothing was removed", () => {
    expect(formatConfigIssues("/c.json", [], neverSecret)).toBeUndefined();
  });

  it("names the file, each path, what it wanted and what it found", () => {
    const { issues } = parseConfigFile({ maxRetries: "5", maxRetrys: 1 });

    expect(formatConfigIssues("/home/u/.jazz/config.json", issues, neverSecret)).toBe(
      "jazz: invalid configuration in /home/u/.jazz/config.json (2 entries):\n" +
        '  maxRetries: expected a whole number of 0 or more, got "5"\n' +
        "  maxRetrys: not a setting — did you mean maxRetries?\n",
    );
  });

  it("requires one complete storage variant", () => {
    expect(parseConfigFile({ storage: { type: "file", path: "/data" } }).issues).toEqual([]);
    expect(parseConfigFile({ storage: { type: "database" } }).issues).toContainEqual({
      kind: "invalid-value",
      path: "storage.connectionString",
      removed: "storage",
      expected: "text",
      actual: undefined,
    });
  });

  it("never echoes a value found at a secret path", () => {
    const { issues } = parseConfigFile({ llm: { openai: { api_key: 123456789 } } });

    const message = formatConfigIssues("/c.json", issues, (path) => path.endsWith("api_key"));

    expect(message).toContain("llm.openai.api_key: expected text, got a number");
    expect(message).not.toContain("123456789");
  });
});

describe("validateEffectiveConfig", () => {
  it("catches an invalid threshold order that may come from two different files", () => {
    expect(
      validateEffectiveConfig({
        context: { warnThresholdRatio: 0.7, compactThresholdRatio: 0.6 },
      }),
    ).toEqual([
      {
        kind: "invalid-value",
        path: "context.warnThresholdRatio",
        removed: "context.warnThresholdRatio",
        expected: "a number below context.compactThresholdRatio",
        actual: 0.7,
      },
    ]);
  });
});

describe("resolveConfigPath", () => {
  it("tells single values from sections", () => {
    expect(resolveConfigPath("maxRetries")).toEqual({ known: true, structured: false });
    expect(resolveConfigPath("output")).toEqual({ known: true, structured: true });
    expect(resolveConfigPath("mcpServers.any-server.enabled")).toEqual({
      known: true,
      structured: false,
    });
  });

  it("suggests the nearest real path for a typo, including deeper segments", () => {
    expect(resolveConfigPath("maxRetrys")).toEqual({ known: false, suggestion: "maxRetries" });
    expect(resolveConfigPath("ouput.mode")).toEqual({ known: false, suggestion: "output.mode" });
  });

  it("does not guess when nothing is close, and does not address list entries", () => {
    expect(resolveConfigPath("defaultModel")).toEqual({ known: false });
    expect(resolveConfigPath("webhooks.0.name")).toEqual({ known: false });
    expect(resolveConfigPath("output..mode")).toEqual({ known: false });
    expect(resolveConfigPath("mcpServers.__proto__.enabled")).toEqual({ known: false });
  });
});

describe("parseConfigInput", () => {
  it("reads numeric settings as numbers", () => {
    expect(parseConfigInput("llm.streamIdleTimeoutMs", "600000")).toEqual({
      ok: true,
      value: 600000,
    });
    expect(parseConfigInput("maxRetries", " 5 ")).toEqual({ ok: true, value: 5 });
    expect(parseConfigInput("maxCostUSD", "2.50")).toEqual({ ok: true, value: 2.5 });
    expect(parseConfigInput("maxRetries", "0")).toEqual({ ok: true, value: 0 });
  });

  it("reads boolean settings from the literals people type", () => {
    for (const raw of ["true", "TRUE", "yes", "on", "1"]) {
      expect(parseConfigInput("output.collapseReasoning", raw)).toEqual({ ok: true, value: true });
    }
    for (const raw of ["false", "False", "no", "off", "0"]) {
      expect(parseConfigInput("output.collapseReasoning", raw)).toEqual({ ok: true, value: false });
    }
  });

  it("keeps text settings exactly as typed", () => {
    expect(parseConfigInput("llm.ollama.keep_alive", "-1")).toEqual({ ok: true, value: "-1" });
    expect(parseConfigInput("llm.openai.api_key", " sk-abc ")).toEqual({
      ok: true,
      value: " sk-abc ",
    });
  });

  it("reads choices, tolerating case", () => {
    expect(parseConfigInput("output.streaming.enabled", "auto")).toEqual({
      ok: true,
      value: "auto",
    });
    expect(parseConfigInput("output.streaming.enabled", "off")).toEqual({ ok: true, value: false });
    expect(parseConfigInput("scheduler.mode", "In-Process")).toEqual({
      ok: true,
      value: "in-process",
    });
  });

  it("refuses what the setting cannot hold, naming what it can", () => {
    expect(parseConfigInput("maxRetries", "2.5")).toEqual({
      ok: false,
      reason: "invalid",
      expected: "a whole number of 0 or more",
      kind: "whole-number",
    });
    expect(parseConfigInput("llm.streamIdleTimeoutMs", "600000ms")).toMatchObject({
      ok: false,
      kind: "whole-number",
    });
    expect(parseConfigInput("maxRetries", "Infinity").ok).toBe(false);
    expect(parseConfigInput("notifications.enabled", "maybe")).toMatchObject({
      ok: false,
      expected: "true or false",
      kind: "boolean",
    });
    expect(parseConfigInput("scheduler.mode", "cron")).toMatchObject({
      ok: false,
      expected: "auto or in-process",
      kind: "choice",
    });
  });

  it("refuses sections and unknown paths", () => {
    expect(parseConfigInput("output", "hybrid")).toEqual({ ok: false, reason: "structured" });
    expect(parseConfigInput("maxRetrys", "5")).toEqual({
      ok: false,
      reason: "unknown-key",
      suggestion: "maxRetries",
    });
  });
});

describe("checkConfigWrite", () => {
  it("accepts what the wizard, the MCP commands and the peer invites write", () => {
    expect(checkConfigWrite("output.mode", "raw")).toEqual({ ok: true });
    expect(checkConfigWrite("output.colorProfile", undefined)).toEqual({ ok: true });
    expect(checkConfigWrite("mcpServers.github", { enabled: true, trusted: false })).toEqual({
      ok: true,
    });
    expect(checkConfigWrite("autoApprovedCommands", ["git status"])).toEqual({ ok: true });
    expect(checkConfigWrite("peers", [{ name: "sam", disclosure: "public" }])).toEqual({
      ok: true,
    });
  });

  it("names the path and what it expected when the value does not fit", () => {
    expect(checkConfigWrite("maxRetries", "5")).toEqual({
      ok: false,
      problem: "maxRetries expected a whole number of 0 or more",
    });
    expect(checkConfigWrite("peers", [{ name: "sam", disclosure: "all" }])).toEqual({
      ok: false,
      problem: "peers[0].disclosure expected none, public, internal, or private",
    });
    expect(checkConfigWrite("mcpServers.github", { command: "npx" })).toEqual({
      ok: false,
      problem: 'mcpServers.github expected no key named "command"',
    });
  });

  it("refuses a path that is not a setting", () => {
    expect(checkConfigWrite("wizard.lastUsedAgentId", "a")).toEqual({
      ok: false,
      problem: '"wizard.lastUsedAgentId" is not a setting',
    });
  });

  it("accepts a whole mcpServers entry whose name contains dots", () => {
    expect(checkConfigWrite("mcpServers.com.example.mcp", { enabled: true })).toEqual({ ok: true });
    expect(checkConfigWrite("mcpServers.my.server", { enabled: true, trusted: false })).toEqual({
      ok: true,
    });
  });

  it("still reports a bad field under a dotted server name", () => {
    expect(checkConfigWrite("mcpServers.my.server", { command: "npx" })).toEqual({
      ok: false,
      problem: 'mcpServers.my.server expected no key named "command"',
    });
    expect(checkConfigWrite("mcpServers.my.server", { enabled: "yes" })).toEqual({
      ok: false,
      problem: "mcpServers.my.server.enabled expected true or false",
    });
  });

  it("refuses a server name that would poison the prototype chain", () => {
    expect(checkConfigWrite("mcpServers.__proto__", { enabled: true })).toEqual({
      ok: false,
      problem: '"mcpServers.__proto__" is not a setting',
    });
  });
});
