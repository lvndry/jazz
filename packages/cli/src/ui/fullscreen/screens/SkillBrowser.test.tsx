/** @jsxImportSource @opentui/react */

/** Rendered checks for a long skill catalog and its narrow detail view. */

import type { SkillMetadata } from "@jazz/core/skills/skill-service";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import { SkillBrowser } from "./SkillBrowser";
import { filterSkills, skillDetailRows } from "../../skill-browser";

const skills: readonly SkillMetadata[] = Array.from({ length: 35 }, (_, index) => ({
  name: `skill-${String(index).padStart(2, "0")}`,
  description: index === 28 ? "Read long research papers and summarize findings" : "General helper",
  source: index === 28 ? "plugin" : "builtin",
  path: index === 28 ? "" : `/skills/skill-${index}`,
}));

describe("skill browser", () => {
  it("filters across metadata without losing the original order", () => {
    expect(filterSkills(skills, "plugin research").map((skill) => skill.name)).toEqual([
      "skill-28",
    ]);
    expect(filterSkills(skills, "SKILL-02").map((skill) => skill.name)).toEqual(["skill-02"]);
  });

  it("windows a long list inside a 32 by 10 terminal", async () => {
    const viewport = { width: 32, height: 10 };
    const rendered = await testRender(
      <SkillBrowser
        skills={skills}
        query=""
        caret={0}
        selected={28}
        detail={null}
        detailOffset={0}
        viewport={viewport}
      />,
      viewport,
    );
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    expect(frame).toContain("skill-28");
    expect(frame).not.toContain("skill-00");
    expect(frame).toContain("enter details");
    expect(frame).toContain("esc close");
    expect(frame.split("\n").filter(Boolean)).toHaveLength(10);
  });

  it("wraps the whole description and strips control bytes", async () => {
    const skill = { ...skills[28]!, description: "Read\x1b[31m long research papers ".repeat(8) };
    const rows = skillDetailRows(skill, 32);
    expect(rows.map((row) => row.text).join(" ")).not.toContain("\x1b");
    const viewport = { width: 32, height: 10 };
    const rendered = await testRender(
      <SkillBrowser
        skills={skills}
        query=""
        caret={0}
        selected={28}
        detail={skill}
        detailOffset={8}
        viewport={viewport}
      />,
      viewport,
    );
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    rendered.renderer.destroy();
    expect(frame).toContain("skill: skill-28");
    expect(frame).toContain("esc back");
    expect(frame.split("\n").filter(Boolean)).toHaveLength(10);
  });
});
