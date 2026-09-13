import { describe, expect, it } from "bun:test";
import { renameWorkflowDefinition, renderWorkflowPrompt } from "./workflow-utils";

describe("renameWorkflowDefinition", () => {
  it("rewrites only the frontmatter name and leaves the body untouched", () => {
    const markdown = [
      "---",
      "name: weekly-review",
      'description: "Review the week"',
      "---",
      "",
      "# Weekly review",
      "name: is a word that also appears in the prompt",
      "",
    ].join("\n");

    const renamed = renameWorkflowDefinition(markdown, "my-review");

    expect(renamed).toBe(markdown.replace("name: weekly-review", "name: my-review"));
    expect(renamed).toContain("name: is a word that also appears in the prompt");
  });

  it("returns the input unchanged when there is no frontmatter", () => {
    expect(renameWorkflowDefinition("# Just a prompt\n", "x")).toBe("# Just a prompt\n");
  });
});

describe("renderWorkflowPrompt", () => {
  it("fills every placeholder and leaves the rest of the prompt alone", () => {
    const rendered = renderWorkflowPrompt(
      "The {schedule.label} recap ({schedule.cron}) from {schedule.lastRunAt} to {run.startedAt}. {other}",
      {
        label: "monthly",
        cron: "0 9 1 * *",
        lastRunAt: "2026-08-01T09:00:00.000Z",
        startedAt: "2026-09-01T09:00:00.000Z",
      },
    );

    expect(rendered).toBe(
      "The monthly recap (0 9 1 * *) from 2026-08-01T09:00:00.000Z to 2026-09-01T09:00:00.000Z. {other}",
    );
  });

  it("renders a first run's lastRunAt as empty", () => {
    expect(
      renderWorkflowPrompt("since {schedule.lastRunAt}.", {
        label: "manual",
        cron: "",
        lastRunAt: undefined,
        startedAt: "now",
      }),
    ).toBe("since .");
  });
});
