import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  answerNotices,
  doneSummary,
  FOLLOWUP_OPTIONS,
  followupChoices,
  followupPrompt,
  planCompositionDelivery,
  usageLines,
} from "./answer";
import type { JazzSuccessEnvelope } from "./jazz-run";
import { renderPlain } from "./surface";

const OK: JazzSuccessEnvelope = { ok: true, answer: "hi", costUSD: 0 };

describe("answerNotices", () => {
  test("says nothing for a complete answer with tools", () => {
    expect(answerNotices(OK)).toEqual([]);
  });

  test("warns loudly when the model was sent no tools", () => {
    const [notice] = answerNotices({ ...OK, toolsDisabled: true });

    expect(notice).toContain("Tools were OFF");
    expect(notice).toContain("capabilityOverrides");
  });

  test("warns about a cut-off answer and an iteration limit", () => {
    expect(answerNotices({ ...OK, truncated: true, iterationLimited: true })).toEqual([
      "⚠️ The answer was cut off at the model's output limit.",
      "⚠️ The agent hit its iteration limit before finishing.",
    ]);
  });
});

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

describe("planCompositionDelivery", () => {
  const home = "/data/chats/tg_1";
  const base = {
    id: "abc",
    title: "Chart",
    sessionId: "session-1",
    filename: "chart.html",
    htmlPath: `${home}/compositions/session-1/chart.html`,
  } as const;
  const options = { home, publicUrlSettingName: "PUBLIC_URL" };

  test("a static app is an image, read from the conversation's own compositions", () => {
    const directory = mkdtempSync(join(tmpdir(), "answer-image-"));
    mkdirSync(join(directory, "compositions", "session-1"), { recursive: true });
    writeFileSync(join(directory, "compositions", "session-1", "abc.png"), Buffer.from([1, 2]));
    const imagePath = join(directory, "compositions", "session-1", "abc.png");
    const plan = planCompositionDelivery(
      { ...base, mode: "static", imagePath },
      { ...options, home: directory },
    );
    expect(plan.kind).toBe("image");
    if (plan.kind === "image") {
      expect(plan.file.path).toBe(imagePath);
      expect([...plan.file.bytes]).toEqual([1, 2]);
      expect(plan.caption).toBe("Chart");
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test("an image path outside the conversation's compositions is never sent", () => {
    for (const imagePath of [
      "/data/chats/tg_2/compositions/session-1/abc.png",
      `${home}/config.json`,
      `${home}/compositions/session-1/../../config.png`,
      "/etc/shadow",
    ]) {
      expect(planCompositionDelivery({ ...base, mode: "static", imagePath }, options).kind).toBe(
        "nothing",
      );
    }
  });

  test("a static app with no image is logged, not sent as an empty message", () => {
    const plan = planCompositionDelivery({ ...base, mode: "static" }, options);
    expect(plan.kind).toBe("nothing");
  });

  test("an interactive app becomes the link the bridge published", () => {
    const plan = planCompositionDelivery(
      { ...base, mode: "interactive" },
      { ...options, publish: () => "https://jazz.example/compositions/1234" },
    );
    expect(plan).toEqual({
      kind: "link",
      url: "https://jazz.example/compositions/1234",
      title: "Chart",
    });
  });

  test("with nowhere to publish it names the setting instead of failing silently", () => {
    const plan = planCompositionDelivery({ ...base, mode: "interactive" }, options);
    expect(plan.kind).toBe("unavailable");
    expect(plan.kind === "unavailable" && renderPlain(plan.body)).toContain("PUBLIC_URL");
  });
});
