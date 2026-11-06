/**
 * Turns `JAZZ_GOLDEN_RECORD` into a recorder for the AI SDK service.
 *
 * Set `JAZZ_GOLDEN_RECORD=<path>.json` (and optionally `JAZZ_GOLDEN_SCENARIO=<name>`) on any
 * Jazz run to write a scrubbed golden fixture of its model calls to that path. Every secret-like
 * environment value (names ending in KEY, TOKEN, SECRET or PASSWORD) is scrubbed by value, and
 * the configured provider keys passed in `knownSecrets` are scrubbed too. Without the variable
 * nothing is recorded and nothing is written.
 */

import { basename } from "node:path";
import { createGoldenRecorder, type GoldenRecorder, type GoldenRequestSummary } from "./fixture";

export const GOLDEN_RECORD_ENV = "JAZZ_GOLDEN_RECORD";
export const GOLDEN_SCENARIO_ENV = "JAZZ_GOLDEN_SCENARIO";

const SECRET_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD)$/i;

export function secretEnvValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && value !== undefined && value !== "")
    .map(([, value]) => value as string);
}

export interface MessageLike {
  readonly role: string;
  readonly name?: string | undefined;
  readonly content?: unknown;
}

export interface ToolLike {
  readonly function: { readonly name: string };
}

/** Summarize a model request into what a golden fixture keeps. */
export function summarizeRequest(
  messages: readonly MessageLike[],
  tools: readonly ToolLike[] | undefined,
): GoldenRequestSummary {
  return {
    messageRoles: messages.map((message) => message.role),
    toolNames: (tools ?? []).map((tool) => tool.function.name),
    toolResults: messages
      .filter((message) => message.role === "tool")
      .map((message) => ({
        toolName: message.name ?? "unknown",
        content: typeof message.content === "string" ? message.content : "",
      })),
  };
}

export function goldenRecorderFromEnv(
  provider: string,
  model: string,
  knownSecrets: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoldenRecorder | undefined {
  const path = env[GOLDEN_RECORD_ENV];
  if (path === undefined || path === "") {
    return undefined;
  }
  return createGoldenRecorder({
    path,
    scenario: env[GOLDEN_SCENARIO_ENV] ?? basename(path, ".json"),
    provider,
    model,
    secrets: [...secretEnvValues(env), ...knownSecrets],
  });
}
