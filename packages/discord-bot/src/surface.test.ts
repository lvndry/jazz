import { createChoiceTokens } from "@jazz/bot-shared/choice-tokens";
import { bold, line, markdown, quote } from "@jazz/bot-shared/surface";
import { describe, expect, test } from "bun:test";
import { choiceComponents, renderDiscordMessage } from "./surface";

describe("choiceComponents", () => {
  test("up to five choices are buttons whose ids resolve back to the prompt", () => {
    const tokens = createChoiceTokens();
    const rows = choiceComponents(
      tokens,
      [
        { id: "approve", label: "Approve", intent: "primary" },
        { id: "reject", label: "Reject", intent: "danger" },
      ],
      "call_1",
    ) as { components: { custom_id: string }[] }[];
    expect(rows).toHaveLength(1);
    const ids = rows[0]?.components.map((component) => component.custom_id) ?? [];
    expect(ids.map((id) => tokens.read(id))).toEqual([
      { promptId: "call_1", choiceId: "approve" },
      { promptId: "call_1", choiceId: "reject" },
    ]);
  });

  test("more than five become a select menu whose values resolve", () => {
    const tokens = createChoiceTokens();
    const choices = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      label: `m${index}`,
    }));
    const rows = choiceComponents(tokens, choices, "command:model") as {
      components: { type: number; options: { value: string }[] }[];
    }[];
    const menu = rows[0]?.components[0];
    expect(menu?.type).toBe(3);
    expect(tokens.read(menu?.options[3]?.value ?? "")).toEqual({
      promptId: "command:model",
      choiceId: "m3",
    });
  });
});

describe("renderDiscordMessage", () => {
  test("passes Markdown through, collapses an expandable quote into a spoiler, defuses pings", () => {
    const rendered = renderDiscordMessage({
      body: [line(bold("Hi")), markdown("**x** @everyone"), quote("thinking", true)],
    });
    expect(rendered).toContain("**Hi**");
    expect(rendered).toContain("**x**");
    expect(rendered).not.toContain("@everyone");
    expect(rendered).toContain("||thinking||");
  });
});
