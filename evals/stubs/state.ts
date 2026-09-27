/**
 * Where the stub commands in `impl.ts` keep their state and invocation log under a sample's
 * stub root, and how both are read and written. The stubs, the sandbox that creates the root,
 * the scenarios that seed it, and the oracles that inspect it all go through here, so the
 * layout is defined once.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonLines } from "../files";

export interface StubInvocation {
  at: string;
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number;
  note?: string;
}

export function stubLogPath(stubRoot: string): string {
  return join(stubRoot, "invocations.ndjson");
}

export function stubStateDirectory(stubRoot: string): string {
  return join(stubRoot, "data");
}

export function stubStatePath(stubRoot: string, tool: string): string {
  return join(stubStateDirectory(stubRoot), `${tool}.json`);
}

export function stubState<State>(stubRoot: string, tool: string): State | undefined {
  const path = stubStatePath(stubRoot, tool);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as State) : undefined;
}

export function writeStubState(stubRoot: string, tool: string, state: unknown): void {
  writeFileSync(stubStatePath(stubRoot, tool), `${JSON.stringify(state, null, 2)}\n`);
}

export function appendStubInvocation(stubRoot: string, invocation: StubInvocation): void {
  appendFileSync(stubLogPath(stubRoot), `${JSON.stringify(invocation)}\n`);
}

export function stubInvocations(stubRoot: string): StubInvocation[] {
  return readJsonLines<StubInvocation>(stubLogPath(stubRoot));
}
