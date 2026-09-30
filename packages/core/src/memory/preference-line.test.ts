import { describe, expect, test } from "bun:test";
import {
  countInjectedPreferenceLines,
  describeTopicSituation,
  formatPreferenceLine,
  formatSituationalPreferenceLine,
  PREFERENCES_HEADING,
  SITUATIONAL_PREFERENCES_HEADING,
} from "./preference-line";

describe("describeTopicSituation", () => {
  test("reads a topic directory name as the situation it names", () => {
    expect(describeTopicSituation("writing-to-friends")).toBe("writing to friends");
  });

  test("collapses runs of hyphens", () => {
    expect(describeTopicSituation("sending--email")).toBe("sending email");
  });
});

describe("formatSituationalPreferenceLine", () => {
  test("puts the scope first and the situation in parentheses", () => {
    expect(
      formatSituationalPreferenceLine({
        scope: "personal",
        topic: "writing-to-friends",
        summary: 'The user said: "use humor"',
        path: "personal/when/writing-to-friends/humor.md",
      }),
    ).toBe(
      '- [personal] (writing to friends) The user said: "use humor" [personal/when/writing-to-friends/humor.md]',
    );
  });
});

describe("countInjectedPreferenceLines", () => {
  test("counts the lines of both sections and nothing else", () => {
    const systemPrompt = [
      "## Tools",
      "- [not a preference] listed under another heading",
      PREFERENCES_HEADING,
      "Follow these.",
      formatPreferenceLine({ scope: "personal", summary: "concise replies" }),
      "",
      SITUATIONAL_PREFERENCES_HEADING,
      "Apply every one that matches.",
      formatSituationalPreferenceLine({
        scope: "work",
        topic: "sending-email",
        summary: "sign",
        path: "work/when/sending-email/sign.md",
      }),
      formatSituationalPreferenceLine({
        scope: "work",
        topic: "food",
        summary: "no cilantro",
        path: "work/when/food/cilantro.md",
      }),
      "## Skills",
      "- [skill] unrelated",
    ].join("\n");

    expect(countInjectedPreferenceLines(systemPrompt)).toBe(3);
  });

  test("counts nothing when a prompt has neither section", () => {
    expect(countInjectedPreferenceLines("## Tools\n- [x] y")).toBe(0);
  });
});
