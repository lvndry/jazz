/**
 * Reads what `jazz workflow run --json` printed and tells the posting steps in jazz.yml what
 * happened, so a failed run is reported as the failure it was instead of as an unparseable
 * verdict.
 *
 * The run step tees stdout (one JSON envelope) to a file and records the exit code; the
 * `actions/github-script` posting steps load this module with
 * `require('./.github/jazz/scripts/run-outcome.cjs')` and call `readRunOutcome`.
 *
 * Outcomes:
 * - `answered`: the envelope has `ok: true`; `answer` is the agent's text.
 * - `failed`: the envelope has `ok: false` (or there is no envelope); `headline` is a short
 *   cause for a PR comment ("provider authentication failed"), `detail` the redacted error.
 * - `parked`: the run stopped for an approval nobody can give in CI.
 *
 * `transient` marks failures a re-run can fix (rate limits, timeouts), which the posting steps
 * report as a warning instead of failing the job.
 */

const fs = require("fs");

/** Error text patterns, checked in order, mapped to the headline a PR comment shows. */
const FAILURE_CAUSES = [
  {
    pattern: /authentication failed|incorrect api key|invalid api key|unauthorized|\b401\b/i,
    headline: "provider authentication failed",
    transient: false,
  },
  {
    pattern: /rate.?limit|too many requests|\b429\b|quota/i,
    headline: "the provider rate-limited the run",
    transient: true,
  },
  {
    pattern: /timed? ?out|timeout|deadline/i,
    headline: "the run timed out",
    transient: true,
  },
  {
    pattern: /no model provider api key/i,
    headline: "no provider API key is configured",
    transient: false,
  },
];

/** Provider keys that providers echo back partly masked (for example `sk-proj-****1N8A`). */
const API_KEY_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_*-]{6,}/g;

/** Longest error text a PR comment quotes; the full text stays in the job log. */
const MAX_DETAIL_LENGTH = 600;

function redact(text) {
  const redacted = String(text).replace(API_KEY_PATTERN, "[redacted key]");
  return redacted.length > MAX_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}…`
    : redacted;
}

function classifyFailure(message) {
  const cause = FAILURE_CAUSES.find((candidate) => candidate.pattern.test(message));
  return cause
    ? { headline: cause.headline, transient: cause.transient }
    : { headline: "the run failed", transient: false };
}

/** The last stdout line that parses as a Jazz envelope (an object with a boolean `ok`). */
function findEnvelope(raw) {
  const lines = raw.split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.ok === "boolean") {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function readExitCode(exitCodePath) {
  try {
    const parsed = Number.parseInt(fs.readFileSync(exitCodePath, "utf8").trim(), 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/**
 * Describe one run from its captured stdout and exit-code files.
 *
 * @param {string} outputPath file holding the run's stdout
 * @param {string} exitCodePath file holding the run's exit code
 */
function readRunOutcome(outputPath, exitCodePath) {
  let raw;
  try {
    raw = fs.readFileSync(outputPath, "utf8");
  } catch {
    return {
      kind: "failed",
      headline: "the run step did not produce any output",
      detail: "The Jazz step ended before the run started. The job log has the cause.",
      transient: false,
    };
  }

  const exitCode = readExitCode(exitCodePath);
  const envelope = findEnvelope(raw);

  if (envelope?.ok === true) {
    return {
      kind: "answered",
      answer: typeof envelope.answer === "string" ? envelope.answer : "",
      costUSD: typeof envelope.costUSD === "number" ? envelope.costUSD : undefined,
      capped:
        envelope.costCapped === true ||
        envelope.tokenCapped === true ||
        envelope.durationCapped === true,
    };
  }

  if (envelope?.state === "input-required") {
    const toolName = envelope.pending?.toolName ?? "a tool";
    return {
      kind: "parked",
      headline: `the agent stopped to ask for approval to run \`${toolName}\``,
      detail: redact(envelope.pending?.message ?? ""),
      transient: false,
    };
  }

  const message =
    typeof envelope?.error === "string" && envelope.error.length > 0
      ? envelope.error
      : `jazz exited with status ${exitCode ?? "unknown"} and printed no result envelope.`;
  return { kind: "failed", ...classifyFailure(message), detail: redact(message) };
}

/**
 * Markdown for a run that produced no answer: "<subject> skipped: <headline>.", the quoted
 * cause, and the run link.
 *
 * @param {string} subject what was skipped, for example "Review"
 */
function describeFailure(outcome, runUrl, subject) {
  const quoted = outcome.detail
    ? `\n\n${outcome.detail
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`
    : "";
  const retry = outcome.transient ? " Re-run the workflow to retry." : "";
  return `${subject} skipped: ${outcome.headline}.${quoted}\n\nSee the [workflow run](${runUrl}) for the full log.${retry}`;
}

module.exports = { readRunOutcome, describeFailure, redact };
