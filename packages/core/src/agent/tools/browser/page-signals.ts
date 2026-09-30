/**
 * What the browser can tell about a page from its structure, and the flags that follow.
 *
 * A flag only ever adds scrutiny: a flagged page makes `browser_act` ask a person on every call
 * (even under an allowlist or yolo) and puts a warning in front of the model and the approver.
 * Nothing here, and nothing a plugin returns, lowers a risk, skips an approval, or clears taint.
 */

import type { Page } from "puppeteer-core";
import {
  MAX_PAGE_ELEMENTS,
  MAX_PAGE_LABEL_CHARS,
  type ClassifyPageOutcome,
  type PageElementSummary,
  type PageFlagId,
  type PageStructuralSignals,
} from "@/core/types/plugin";
import type { SnapshotRef } from "./snapshot";

/**
 * A flag from a classification counts at or above this probability. The flag only adds an
 * approval prompt and a warning, so a false positive costs one click; the bar sits at even odds
 * instead of the higher one a decision that loosened something would need.
 */
export const PAGE_FLAG_MIN_PROBABILITY = 0.5;

/** Every flag, in the order a warning lists them. */
export const PAGE_FLAG_ORDER: readonly PageFlagId[] = [
  "credential-entry",
  "payment",
  "captcha",
  "agent-directed-instructions",
];

const PASSWORD_FIELD_SELECTOR = 'input[type="password"]';

/** Card field tokens from the HTML Standard's autofill field names. */
const PAYMENT_AUTOCOMPLETE_TOKENS: readonly string[] = [
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
];

const PAYMENT_FIELD_SELECTOR = PAYMENT_AUTOCOMPLETE_TOKENS.map(
  (token) => `input[autocomplete~="${token}"]`,
).join(",");

const FLAG_NOTICES: Readonly<Record<PageFlagId, string>> = {
  "credential-entry": "this page has a password field",
  payment: "this page has payment card fields",
  captcha: "this page may be asking whether you are a person",
  "agent-directed-instructions": "this page may contain text addressed to an AI agent",
};

const ELEMENT_LABEL_PATTERN = /^(\S+)(?: ("(?:[^"\\]|\\.)*"))?$/;

/**
 * Whether the page's own document holds a password or card field. Fields inside a cross-origin
 * frame are not visible to this check. A page that cannot be evaluated reads as having neither.
 */
export async function readPageSignals(page: Page): Promise<PageStructuralSignals> {
  try {
    return await page.evaluate(
      (passwordSelector, paymentSelector) => ({
        passwordField: document.querySelector(passwordSelector) !== null,
        paymentField: document.querySelector(paymentSelector) !== null,
      }),
      PASSWORD_FIELD_SELECTOR,
      PAYMENT_FIELD_SELECTOR,
    );
  } catch {
    return { passwordField: false, paymentField: false };
  }
}

function builtInFlags(signals: PageStructuralSignals): readonly PageFlagId[] {
  return [
    ...(signals.passwordField ? (["credential-entry"] as const) : []),
    ...(signals.paymentField ? (["payment"] as const) : []),
  ];
}

/** The flags a classification put at or above the threshold; none when it abstained. */
export function flagsFromClassification(
  classification: ClassifyPageOutcome | undefined,
): readonly PageFlagId[] {
  if (classification?.status !== "answered") {
    return [];
  }
  return classification.flags
    .filter(({ probability }) => probability >= PAGE_FLAG_MIN_PROBABILITY)
    .map(({ flag }) => flag);
}

/** The flags for a page: what its structure shows, plus flags raised earlier for it. */
export function combineFlags(
  signals: PageStructuralSignals,
  raisedEarlier: readonly PageFlagId[],
): readonly PageFlagId[] {
  const raised = new Set<PageFlagId>([...builtInFlags(signals), ...raisedEarlier]);
  return PAGE_FLAG_ORDER.filter((flag) => raised.has(flag));
}

/** One sentence for the model and the approver, worded by Jazz from the flag names alone. */
export function describeFlags(flags: readonly PageFlagId[]): string | undefined {
  if (flags.length === 0) {
    return undefined;
  }
  const listed = flags.map((flag) => FLAG_NOTICES[flag]).join("; ");
  return `Warning: ${listed}. Enter information here only if you expect this site to receive it.`;
}

function unquote(quoted: string): string {
  try {
    const parsed: unknown = JSON.parse(quoted);
    return typeof parsed === "string" ? parsed : quoted;
  } catch {
    return quoted;
  }
}

/** The snapshot's interactive elements as role and label pairs, in page order and bounded. */
export function summarizeElements(
  refs: ReadonlyMap<string, SnapshotRef>,
): readonly PageElementSummary[] {
  const summaries: PageElementSummary[] = [];
  for (const [ref, { label }] of refs) {
    if (summaries.length >= MAX_PAGE_ELEMENTS) {
      break;
    }
    const match = ELEMENT_LABEL_PATTERN.exec(label);
    const role = match?.[1] ?? label;
    const name = match?.[2] === undefined ? "" : unquote(match[2]);
    summaries.push({
      ref,
      role: role.slice(0, MAX_PAGE_LABEL_CHARS),
      label: name.slice(0, MAX_PAGE_LABEL_CHARS),
    });
  }
  return summaries;
}
