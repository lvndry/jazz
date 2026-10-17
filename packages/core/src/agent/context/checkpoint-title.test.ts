import { describe, expect, test } from "bun:test";
import { checkpointTitle } from "./checkpoint-title";

describe("checkpointTitle", () => {
  test("reads the first line under the Title heading", () => {
    expect(checkpointTitle("## Title\n\nItaly rail itinerary\n\n## Goal\nPlan the trip")).toBe(
      "Italy rail itinerary",
    );
  });

  test("strips list markers, emphasis, quotes, and a trailing period", () => {
    expect(checkpointTitle('## Title\n- **"Italy rail itinerary."**\n## Goal')).toBe(
      "Italy rail itinerary",
    );
  });

  test("has no title when the section is missing, empty, or (none)", () => {
    expect(checkpointTitle("## Goal\nPlan the trip")).toBeUndefined();
    expect(checkpointTitle("## Title\n\n## Goal\nPlan the trip")).toBeUndefined();
    expect(checkpointTitle("## Title\n(none)\n## Goal")).toBeUndefined();
  });

  test("caps a long title", () => {
    const title = checkpointTitle(`## Title\n${"word ".repeat(40)}`);
    expect(title?.endsWith("…")).toBe(true);
    expect(Array.from(title ?? "").length).toBe(80);
  });
});
