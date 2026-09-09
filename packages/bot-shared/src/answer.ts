/**
 * @fileoverview What goes under an answer, and what a web app turns into.
 *
 * All of this was written twice — once in the Telegram bridge and once in the
 * Discord one — and the copies had already begun to disagree. `formatUsageLines`
 * differs only by Discord's `-# ` subtext prefix; the done summary differs only
 * by `<b>` against `**`. Everything that decides *what is said* — the
 * thresholds, the wording, the follow-up prompts sent to the model, the rule
 * that a static web app is an image and an interactive one needs a URL — was
 * identical in both, which is what makes it a rule rather than a rendering.
 *
 * So the rules live here and produce `RichText`, and each surface renders that
 * in its own dialect. A wording change lands everywhere at once, which is the
 * point: these are promises about someone's money and someone's data.
 */

import type { JazzSuccessEnvelope, JazzWebApp } from "./jazz-run";
import {
  bold,
  type Choice,
  code,
  line,
  plainLine,
  type RichText,
  subtle,
  type Surface,
  text,
} from "./surface";

/**
 * Below this a cost rounds to $0.0000, which reads as free rather than cheap.
 * Shown as a bound instead.
 */
const COST_DISPLAY_FLOOR_USD = 0.0001;

export function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * Input and output split out.
 *
 * A single total hides that the input is the whole conversation plus every tool
 * schema, re-sent on each loop iteration — which is the number that explains a
 * surprising bill.
 */
export function usageLines(usage: JazzSuccessEnvelope["tokenUsage"]): RichText {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0) return [];

  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cached = cacheReadTokens > 0 ? ` (${formatTokenCount(cacheReadTokens)} cached)` : "";
  return [
    subtle(text(`Input: ${formatTokenCount(promptTokens)}${cached}`)),
    subtle(text(`Output: ${formatTokenCount(completionTokens)}`)),
  ];
}

/** The "✅ Done · tools · cost" line that closes a run, plus its usage trailer. */
export function doneSummary(envelope: JazzSuccessEnvelope, toolsUsed: readonly string[]): RichText {
  const spans = [bold("✅ Done")];
  for (const tool of toolsUsed) {
    spans.push(text(" · "), code(tool));
  }

  const costKnown = envelope.costKnown !== false;
  if (envelope.costUSD > 0) {
    spans.push(
      text(" · "),
      text(
        envelope.costUSD >= COST_DISPLAY_FLOOR_USD
          ? `$${envelope.costUSD.toFixed(4)}`
          : `<$${COST_DISPLAY_FLOOR_USD.toFixed(4)}`,
      ),
    );
  } else if (!costKnown) {
    // Said out loud rather than shown as $0: an unpriced run is one the daily
    // cap cannot police, and silence there looks like a free run.
    spans.push(text(" · price unavailable"));
  }

  return [line(...spans), ...usageLines(envelope.tokenUsage)];
}

export function cancelledSummary(): RichText {
  return [line(bold("⏹ Cancelled"))];
}

export function failedSummary(error: string): RichText {
  return [line(bold("⚠️ Failed")), plainLine(error)];
}

/**
 * The standing follow-ups offered under every answer.
 *
 * The `prompt` is sent to the model verbatim when one is tapped, so these are
 * prompt engineering rather than button labels — the reason they belong with
 * the rules and not with either client's widget code.
 */
export const FOLLOWUP_OPTIONS: Readonly<Record<string, { label: string; prompt: string }>> = {
  deeper: {
    label: "🔍 Go deeper",
    prompt:
      "Go deeper on your previous answer: add more detail, concrete specifics, and any important nuances or caveats.",
  },
  shorter: {
    label: "✂️ Shorter",
    prompt:
      "Give a much shorter version of your previous answer — 2-3 sentences, just the essentials.",
  },
  simpler: {
    label: "🧑‍🏫 Explain simpler",
    prompt:
      "Explain your previous answer in simpler terms, as if to someone with no background in the topic — avoid jargon and use plain language.",
  },
  example: {
    label: "💡 Example",
    prompt: "Give a concrete, real-world example that illustrates your previous answer.",
  },
};

export const FOLLOWUP_PROMPT_ID = "followup";

export function followupChoices(): readonly Choice[] {
  return Object.entries(FOLLOWUP_OPTIONS).map(([id, option]) => ({ id, label: option.label }));
}

/** The message a tapped follow-up sends to the agent, or undefined if unknown. */
export function followupPrompt(choiceId: string): string | undefined {
  return FOLLOWUP_OPTIONS[choiceId]?.prompt;
}

/**
 * How a `create_web_app` result should be delivered on a given surface.
 *
 * The rule is the same everywhere and was written out twice: a static app is an
 * image, which every surface can show; an interactive one is a page, which
 * needs somewhere public to serve it from and a way to open it. What differs is
 * only whether the surface can offer that as a tap.
 */
export type WebAppDelivery =
  | { readonly kind: "image"; readonly path: string; readonly caption: string }
  | { readonly kind: "link"; readonly url: string; readonly title: string }
  | { readonly kind: "unavailable"; readonly body: RichText }
  | { readonly kind: "nothing"; readonly logMessage: string };

export function planWebAppDelivery(
  webApp: JazzWebApp,
  publicBaseUrl: string | undefined,
  publicUrlSettingName: string,
): WebAppDelivery {
  if (webApp.mode === "static") {
    return webApp.imagePath === undefined
      ? {
          kind: "nothing",
          logMessage: `create_web_app returned static mode with no imagePath (id=${webApp.id})`,
        }
      : { kind: "image", path: webApp.imagePath, caption: webApp.title };
  }

  if (publicBaseUrl === undefined) {
    return {
      kind: "unavailable",
      body: [
        line(
          text("⚠️ Generated an interactive UI, but no public URL is configured ("),
          code(publicUrlSettingName),
          text(") — can't open it."),
        ),
      ],
    };
  }

  return { kind: "link", url: `${publicBaseUrl}/webapps/${webApp.id}`, title: webApp.title };
}

/** Deliver a planned web app, using whatever the surface can actually do. */
export async function deliverWebApp(
  surface: Surface,
  chatId: string,
  delivery: WebAppDelivery,
): Promise<void> {
  switch (delivery.kind) {
    case "nothing":
      console.error(delivery.logMessage);
      return;
    case "image":
      if (surface.sendFile === undefined) return;
      await surface.sendFile(chatId, delivery.path, delivery.caption);
      return;
    case "unavailable":
      await surface.send(chatId, { body: delivery.body });
      return;
    case "link":
      if (surface.capabilities.linkButtons) {
        await surface.send(chatId, {
          body: [line(text("Tap to open: "), bold(delivery.title))],
          choices: [{ id: "open", label: `📱 ${delivery.title}`, url: delivery.url }],
          choiceKind: "suggestion",
        });
        return;
      }
      // No link button: the URL goes in the text, where it can at least be
      // copied. The alternative is telling someone a page exists and giving
      // them no way to reach it.
      await surface.send(chatId, {
        body: [line(text("Open "), bold(delivery.title), text(`: ${delivery.url}`))],
      });
      return;
  }
}
