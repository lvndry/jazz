import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  CONFIG_REFERENCE_DOC,
  SETTING_DESCRIPTIONS,
  configReferenceRows,
  regeneratedPage,
} from "./gen-config-reference";

describe("config file reference", () => {
  const rows = configReferenceRows();

  it("describes every setting the schema accepts", () => {
    const undescribed = rows.map((row) => row.path).filter((path) => !SETTING_DESCRIPTIONS[path]);
    expect(undescribed).toEqual([]);
  });

  it("describes no setting the schema has dropped", () => {
    const paths = new Set(rows.map((row) => row.path));
    const stale = Object.keys(SETTING_DESCRIPTIONS).filter((path) => !paths.has(path));
    expect(stale).toEqual([]);
  });

  it("marks secrets the way the secret registry does", () => {
    const secrets = rows.filter((row) => row.secret).map((row) => row.path);
    expect(secrets).toContain("llm.<provider>.api_key");
    expect(secrets).toContain("telemetry.otlp.headers.<header>");
    expect(secrets).not.toContain("llm.<provider>.base_url");
  });

  it("matches the published page (run `bun run docs:config-reference`)", async () => {
    const page = readFileSync(CONFIG_REFERENCE_DOC, "utf-8");
    expect(await regeneratedPage(page)).toBe(page);
  });
});
