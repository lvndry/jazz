/**
 * Oracles over what a run did and what it left behind, for the capability scenarios.
 *
 * Trajectory checks read the envelope's `toolCalls` (every call the model made, with full
 * arguments, across all cycles; subagents' own calls are not in it). State checks read the
 * sample's Jazz home (memory, reminders, scratchpad, the memory recall log) and the stub
 * commands' state and invocation log. Nothing here asks the model how it did.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { OneShotResult } from "../../types";

export type ToolCall = OneShotResult["toolCalls"][number];

export function callArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A call's argument as a string, or empty when it is missing or not a string. */
export function stringArgument(call: ToolCall, key: string): string {
  const value = callArguments(call)[key];
  return typeof value === "string" ? value : "";
}

export function callsNamed(result: OneShotResult, name: string): ToolCall[] {
  return result.toolCalls.filter((call) => call.name === name);
}

/** Index of the first call matching the predicate, or -1. */
export function firstCall(result: OneShotResult, predicate: (call: ToolCall) => boolean): number {
  return result.toolCalls.findIndex(predicate);
}

export function isSkillLoad(call: ToolCall, skill: string): boolean {
  return call.name === "load_skill" && callArguments(call)["skill_name"] === skill;
}

export function skillsLoaded(result: OneShotResult): string[] {
  return callsNamed(result, "load_skill")
    .map((call) => callArguments(call)["skill_name"])
    .filter((name): name is string => typeof name === "string");
}

/** Shell commands the model asked to run, in order. */
export function shellCommands(result: OneShotResult): string[] {
  return callsNamed(result, "execute_command")
    .map((call) => callArguments(call)["command"])
    .filter((command): command is string => typeof command === "string");
}

/** Index of the first shell command that mentions `word` as a command, or -1. */
export function firstShellUse(result: OneShotResult, word: string): number {
  const pattern = new RegExp(`(^|[\\s;&|(\`'"=/])${word}(\\s|$)`);
  return firstCall(
    result,
    (call) => call.name === "execute_command" && pattern.test(stringArgument(call, "command")),
  );
}

export interface StubInvocation {
  at: string;
  command: string;
  args: string[];
  exitCode: number;
  note?: string;
}

export function stubInvocations(stubRoot: string): StubInvocation[] {
  const path = join(stubRoot, "invocations.ndjson");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StubInvocation);
}

export function stubState<State>(stubRoot: string, tool: string): State | undefined {
  const path = join(stubRoot, "data", `${tool}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as State) : undefined;
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (entry.isFile() && !entry.name.startsWith(".")) {
      found.push(path);
    }
  }
  return found;
}

export interface MemoryEntry {
  /** Path under `memory/`, e.g. `personal/when/food/partner-diet.md`. */
  path: string;
  content: string;
}

/** Every memory entry in the sample's home, sidecar files excluded. */
export function memoryEntries(jazzHome: string): MemoryEntry[] {
  const root = join(jazzHome, "memory");
  return walk(root)
    .filter((path) => path.endsWith(".md"))
    .map((path) => ({ path: relative(root, path), content: readFileSync(path, "utf8") }));
}

export function memoryMentions(jazzHome: string, pattern: RegExp): MemoryEntry[] {
  return memoryEntries(jazzHome).filter((entry) => pattern.test(entry.content));
}

export interface RecallObservation {
  conversationId: string;
  viewedBeforeFirstAnswer: boolean;
  viewCallCount: number;
  writeCallCount: number;
}

export function recallLog(jazzHome: string): RecallObservation[] {
  const path = join(jazzHome, "memory-recall", "memory-recall.jsonl");
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecallObservation);
}

export interface StoredReminder {
  id: string;
  fireAt: number;
  text: string;
}

export function storedReminders(jazzHome: string, agentId: string): StoredReminder[] {
  const path = join(jazzHome, "reminders", `${agentId}.json`);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { reminders?: unknown[] } | null)?.reminders ?? []);
  return list as StoredReminder[];
}

/** Files the agent keeps in its scratchpad, with their contents. */
export function scratchpadFiles(jazzHome: string): MemoryEntry[] {
  const root = join(jazzHome, "workspace");
  return walk(root).map((path) => ({
    path: relative(root, path),
    content: readFileSync(path, "utf8"),
  }));
}

export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
