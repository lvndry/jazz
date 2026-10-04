import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  combinedProvenance,
  fitSubagentResults,
  saveSubagentResult,
  subagentResultText,
} from "./results";
import type { SubagentSnapshot } from "./supervisor";

const BUDGET = 12_000;

function finished(id: string, result: unknown, extra: Partial<SubagentSnapshot> = {}) {
  return {
    id,
    name: id,
    status: "completed",
    elapsedMs: 1,
    result,
    resultPath: `/results/${id}.md`,
    ...extra,
  } satisfies SubagentSnapshot;
}

const serialize = (subagents: readonly SubagentSnapshot[]) =>
  JSON.stringify({ subagents, timedOut: false });

function report(chars: number): string {
  const line = 'Finding: "sovereign AI" demand, cited [S1]\n';
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

describe("fitSubagentResults", () => {
  it("shows every child within one tool result when their answers together overflow it", () => {
    const fitted = fitSubagentResults(
      [finished("sa-1", report(46_000)), finished("sa-2", report(23_000))],
      BUDGET,
      serialize,
    );

    expect(serialize(fitted).length).toBeLessThanOrEqual(BUDGET);
    expect(fitted.map((child) => child.id)).toEqual(["sa-1", "sa-2"]);
    for (const child of fitted) {
      expect(String(child.result).length).toBeGreaterThan(BUDGET / 3);
      expect(child.resultNote).toContain("read_file at resultPath");
    }
  });

  it("leaves a short answer whole and gives what it leaves to the long one", () => {
    const fitted = fitSubagentResults(
      [finished("short", "Lisbon, €84 return"), finished("long", report(46_000))],
      BUDGET,
      serialize,
    );

    expect(fitted[0]).toEqual(finished("short", "Lisbon, €84 return"));
    expect(String(fitted[1]?.result).length).toBeGreaterThan(BUDGET * 0.7);
    expect(fitted[1]?.resultNote).toMatch(/^Preview: the first \d+ of 46000 chars\./);
  });

  it("returns answers that already fit unchanged", () => {
    const children = [finished("sa-1", "one"), finished("sa-2", { candidates: ["a"] })];
    expect(fitSubagentResults(children, BUDGET, serialize)).toEqual(children);
  });

  it("previews a structured answer as its JSON text", () => {
    const structured = { rows: Array.from({ length: 2_000 }, (_, index) => ({ index })) };
    const [child] = fitSubagentResults([finished("sa-1", structured)], BUDGET, serialize);
    expect(typeof child?.result).toBe("string");
    expect(String(child?.result).startsWith('{\n  "rows"')).toBe(true);
    expect(serialize(child === undefined ? [] : [child]).length).toBeLessThanOrEqual(BUDGET);
  });

  it("says when the whole answer could not be saved", () => {
    const unsaved: SubagentSnapshot = {
      id: "sa-1",
      name: "sa-1",
      status: "completed",
      elapsedMs: 1,
      result: report(30_000),
    };
    const [child] = fitSubagentResults([unsaved], BUDGET, serialize);
    expect(child?.resultNote).toContain("could not be saved");
  });
});

describe("combinedProvenance", () => {
  it("names every child whose external content is shown", () => {
    const provenance = combinedProvenance([
      finished("sa-1", "a", { untrusted: { kind: "external", source: "sub-agent Market" } }),
      finished("sa-2", "b", { untrusted: { kind: "local-file", source: "sub-agent Rates" } }),
    ]);
    expect(provenance).toEqual({ kind: "external", source: "sub-agent Market, sub-agent Rates" });
  });

  it("leaves out a child whose answer is not shown", () => {
    const shown = { kind: "external", source: "sub-agent Market" } as const;
    const provenance = combinedProvenance([
      finished("sa-1", "a", { untrusted: shown }),
      finished("sa-2", undefined, {
        untrusted: { kind: "external", source: "sub-agent Rates" },
        alreadyRead: true,
      }),
    ]);
    expect(provenance).toEqual(shown);
  });
});

describe("saveSubagentResult", () => {
  let directory: string;

  beforeEach(() => {
    directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-subagent-")), "results");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(directory), { recursive: true, force: true });
  });

  it("writes a text answer as markdown and a structured one as JSON", () => {
    const text = saveSubagentResult(directory, { id: "sa-1", startedAt: 1, result: "hi" });
    const structured = saveSubagentResult(directory, {
      id: "sa-2",
      startedAt: 2,
      result: { candidates: ["a"] },
    });
    expect(text).toBe(path.join(directory, "sa-1-1.md"));
    expect(fs.readFileSync(text!, "utf-8")).toBe("hi");
    expect(structured).toBe(path.join(directory, "sa-2-2.json"));
    expect(fs.readFileSync(structured!, "utf-8")).toBe(subagentResultText({ candidates: ["a"] })!);
  });

  it("writes nothing for an empty answer", () => {
    expect(saveSubagentResult(directory, { id: "sa-1", startedAt: 1, result: "  " })).toBe(
      undefined,
    );
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("returns undefined when the directory cannot be written", () => {
    const blocked = path.join(path.dirname(directory), "file");
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, "");
    expect(
      saveSubagentResult(path.join(blocked, "results"), {
        id: "sa-1",
        startedAt: 1,
        result: "hi",
      }),
    ).toBeUndefined();
  });
});
