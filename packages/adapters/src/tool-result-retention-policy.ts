/**
 * Reads destructive-cleanup policy without substituting defaults for a broken configuration.
 * Missing files or an absent setting use the documented default; unreadable files, malformed
 * documents and invalid values fail the pass. Call once per scheduled run before discovery.
 */
import { readFile } from "node:fs/promises";
import { isRecord } from "@jazz/core/utils/is-record";
import { DEFAULT_TOOL_RESULT_RETENTION_DAYS } from "./tool-result-retention";

export function retentionDaysFromDocument(
  document: unknown,
  fallback = DEFAULT_TOOL_RESULT_RETENTION_DAYS,
): number {
  if (!isRecord(document)) {
    throw new Error("Invalid cleanup configuration: expected an object");
  }
  const history = document["history"];
  if (history === undefined) {
    return fallback;
  }
  if (!isRecord(history)) {
    throw new Error("Invalid cleanup history configuration");
  }
  const days = history["toolResultRetentionDays"];
  if (days === undefined) {
    return fallback;
  }
  if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 0) {
    throw new Error("Invalid tool-result retention policy; cleanup skipped");
  }
  return days;
}

export async function readRetentionDaysFromFile(target: string): Promise<number> {
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return DEFAULT_TOOL_RESULT_RETENTION_DAYS;
    }
    throw new Error("Cleanup configuration could not be read; cleanup skipped", { cause: error });
  }
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    throw new Error("Cleanup configuration is not valid JSON; cleanup skipped");
  }
  return retentionDaysFromDocument(document);
}
