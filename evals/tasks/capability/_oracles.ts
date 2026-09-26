/**
 * Oracles over what a run did and what it left behind, for the capability scenarios.
 *
 * Trajectory checks read the envelope's `toolCalls` (every call the model made, with full
 * arguments, across all cycles; subagents' own calls are not in it). State checks read the
 * sample's Jazz home (memory, reminders, scratchpad, the memory recall log); the stub commands'
 * state and invocation log are read through `evals/stubs/state.ts`. Nothing here asks the
 * model how it did.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { memoryEntries, readJsonLines, walkFiles, type MemoryEntry } from "../../files";
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
  return readJsonLines<RecallObservation>(join(jazzHome, "memory-recall", "memory-recall.jsonl"));
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
  return walkFiles(root, { skipDotfiles: true }).map((path) => ({
    path: relative(root, path),
    content: readFileSync(path, "utf8"),
  }));
}

export function requireContext<Context>(context: Context | undefined): Context {
  if (context === undefined) {
    throw new Error("capability checks need the sample context");
  }
  return context;
}

export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
