import { describe, expect, test } from "bun:test";
import {
  doneSummary,
  FOLLOWUP_OPTIONS,
  followupChoices,
  followupPrompt,
  planWebAppDelivery,
  usageLines,
} from "./answer";
import type { JazzSuccessEnvelope } from "./jazz-run";
import { renderPlain } from "./surface";

const OK: JazzSuccessEnvelope = { ok: true, answer: "hi", costUSD: 0 };

describe("doneSummary", () => {
  test("names the tools that ran", () => {
    expect(renderPlain(doneSummary(OK, ["web_search", "read_file"]))).toBe(
      "✅ Done · web_search · read_file",
    );
  });

  test("shows a cost that would otherwise round to zero as a bound", () => {
    const summary = renderPlain(doneSummary({ ...OK, costUSD: 0.000_04 }, []));
    expect(summary).toContain("<$0.0001");
    expect(summary).not.toContain("$0.0000");
  });

  test("shows a real cost to four places", () => {
    expect(renderPlain(doneSummary({ ...OK, costUSD: 0.0123 }, []))).toContain("$0.0123");
  });

  test("says so when the price is unknown, which the daily cap cannot police", () => {
    expect(renderPlain(doneSummary({ ...OK, costUSD: 0, costKnown: false }, []))).toContain(
      "price unavailable",
    );
  });

  test("stays quiet about cost when there is nothing to report", () => {
    const summary = renderPlain(doneSummary(OK, []));
    expect(summary).toBe("✅ Done");
  });
});

describe("usageLines", () => {
  test("splits input from output, which is what explains a surprising bill", () => {
    expect(renderPlain(usageLines({ promptTokens: 12_400, completionTokens: 850 }))).toBe(
      "Input: 12.4k\nOutput: 850",
    );
  });

  test("reports the cached share of the input", () => {
    expect(
      renderPlain(
        usageLines({ promptTokens: 12_400, completionTokens: 850, cacheReadTokens: 9_000 }),
      ),
    ).toContain("(9.0k cached)");
  });

  test("renders nothing when the run reported no tokens", () => {
    expect(usageLines(undefined)).toEqual([]);
    expect(usageLines({ promptTokens: 0, completionTokens: 0 })).toEqual([]);
  });

  test("marks the trailer as receding rather than baking in a prefix", () => {
    // The bridges disagreed here — Discord prefixed `-# `, Telegram did not —
    // because the mark lived at the call site. It is a role now.
    expect(
      usageLines({ promptTokens: 10, completionTokens: 5 }).every(
        (block) => block.kind === "subtle",
      ),
    ).toBe(true);
  });
});

describe("follow-ups", () => {
  test("every offered choice has a prompt to send", () => {
    for (const choice of followupChoices()) {
      expect(followupPrompt(choice.id)).toBeDefined();
    }
  });

  test("an unknown choice yields no prompt rather than an empty turn", () => {
    expect(followupPrompt("nope")).toBeUndefined();
  });

  test("labels stay short enough to read on a phone-width button", () => {
    for (const option of Object.values(FOLLOWUP_OPTIONS)) {
      expect(option.label.length).toBeLessThanOrEqual(24);
    }
  });
});

describe("planWebAppDelivery", () => {
  const base = { id: "abc", title: "Chart", htmlPath: "/tmp/abc.html" } as const;

  test("a static app is an image, which every surface can show", () => {
    const plan = planWebAppDelivery(
      { ...base, mode: "static", imagePath: "/tmp/abc.png" },
      undefined,
      "PUBLIC_URL",
    );
    expect(plan).toEqual({ kind: "image", path: "/tmp/abc.png", caption: "Chart" });
  });

  test("a static app with no image is logged, not sent as an empty message", () => {
    const plan = planWebAppDelivery({ ...base, mode: "static" }, undefined, "PUBLIC_URL");
    expect(plan.kind).toBe("nothing");
  });

  test("an interactive app becomes a link under the configured origin", () => {
    const plan = planWebAppDelivery(
      { ...base, mode: "interactive" },
      "https://jazz.example",
      "PUBLIC_URL",
    );
    expect(plan).toEqual({ kind: "link", url: "https://jazz.example/webapps/abc", title: "Chart" });
  });

  test("with no origin it names the setting instead of failing silently", () => {
    const plan = planWebAppDelivery({ ...base, mode: "interactive" }, undefined, "PUBLIC_URL");
    expect(plan.kind).toBe("unavailable");
    expect(plan.kind === "unavailable" && renderPlain(plan.body)).toContain("PUBLIC_URL");
  });
});
