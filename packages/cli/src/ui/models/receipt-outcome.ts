/**
 * What a settled tool call came back with, as a short phrase for its receipt —
 * `300 lines`, `12 entries`, `23 matches`, `exit 1`. A receipt names the outcome
 * and never quotes the result: the content itself lives behind the expand key.
 *
 * Derived from the shape of the tool's JSON result rather than from its name, so
 * a new tool gets a meaningful receipt the moment it returns a conventional field.
 */

const MAX_MESSAGE_CELLS = 60;

const COLLECTION_NOUNS: ReadonlyArray<readonly [field: string, noun: string]> = [
  ["matches", "match"],
  ["results", "result"],
  ["files", "file"],
  ["entries", "entry"],
  ["items", "item"],
  ["children", "entry"],
  ["counts", "file"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plural(count: number, noun: string): string {
  if (count === 1) {
    return `1 ${noun}`;
  }
  const irregular: Record<string, string> = { match: "matches", entry: "entries" };
  return `${count.toLocaleString("en-US")} ${irregular[noun] ?? `${noun}s`}`;
}

function lineCount(text: string): number {
  const trimmed = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function shortMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.includes("\n") || trimmed.length > MAX_MESSAGE_CELLS) {
    return undefined;
  }
  return trimmed;
}

function diffStat(diff: string): string | undefined {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  if (added === 0 && removed === 0) {
    return undefined;
  }
  return `+${String(added)} −${String(removed)}`;
}

function todoProgress(todos: readonly unknown[]): string {
  const done = todos.filter((todo) => isRecord(todo) && todo["status"] === "completed").length;
  return `${String(done)} of ${String(todos.length)} done`;
}

function recordOutcome(record: Record<string, unknown>): string | undefined {
  const exitCode = record["exitCode"];
  if (typeof exitCode === "number") {
    if (exitCode !== 0) {
      return `exit ${String(exitCode)}`;
    }
    const stdout = typeof record["stdout"] === "string" ? lineCount(record["stdout"]) : 0;
    return stdout > 0 ? plural(stdout, "line") : "done";
  }

  if (Array.isArray(record["todos"])) {
    return todoProgress(record["todos"]);
  }

  const totalLines = record["totalLines"];
  if (typeof totalLines === "number") {
    const range = record["range"];
    if (
      isRecord(range) &&
      typeof range["startLine"] === "number" &&
      typeof range["endLine"] === "number"
    ) {
      const covered = range["endLine"] - range["startLine"] + 1;
      if (covered < totalLines) {
        return `lines ${String(range["startLine"])}–${String(range["endLine"])} of ${String(totalLines)}`;
      }
    }
    return plural(totalLines, "line");
  }

  if (typeof record["isNewFile"] === "boolean") {
    const stat = typeof record["diff"] === "string" ? diffStat(record["diff"]) : undefined;
    const verb = record["isNewFile"] ? "created" : "written";
    return stat === undefined ? verb : `${verb} ${stat}`;
  }

  const status = record["status"];
  if (typeof status === "number" && status >= 100 && status < 600) {
    return `HTTP ${String(status)}`;
  }

  for (const [field, noun] of COLLECTION_NOUNS) {
    const value = record[field];
    if (Array.isArray(value)) {
      return value.length === 0 ? "none" : plural(value.length, noun);
    }
  }

  if (typeof record["totalFound"] === "number") {
    return plural(record["totalFound"], "match");
  }

  if (typeof record["content"] === "string") {
    return plural(lineCount(record["content"]), "line");
  }

  if (typeof record["message"] === "string") {
    const message = shortMessage(record["message"]);
    if (message !== undefined) {
      return message;
    }
  }

  for (const field of ["outcome", "result"]) {
    const nested = record[field];
    if (nested !== undefined && nested !== null) {
      const outcome = valueOutcome(nested);
      if (outcome !== undefined) {
        return outcome;
      }
    }
  }

  return undefined;
}

function valueOutcome(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 0 ? "none" : plural(value.length, "entry");
  }
  if (isRecord(value)) {
    return recordOutcome(value);
  }
  if (typeof value === "string") {
    return shortMessage(value) ?? plural(lineCount(value), "line");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** A short outcome phrase for a tool's raw result string, or undefined when nothing useful can be said. */
export function receiptOutcome(rawResult: string): string | undefined {
  const trimmed = rawResult.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return shortMessage(trimmed) ?? plural(lineCount(trimmed), "line");
  }
  return valueOutcome(parsed);
}

/** True when a tool result is the declined-by-a-person shape the executor returns. */
export function isRejectedResult(rawResult: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawResult);
    if (!isRecord(parsed)) {
      return false;
    }
    if (parsed["rejected"] === true) {
      return true;
    }
    const inner = parsed["result"];
    return isRecord(inner) && inner["rejected"] === true;
  } catch {
    return false;
  }
}
