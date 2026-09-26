/** Scaffolding for oracle tests: setting a scenario up and cleaning up after each test. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import { findTask, type EvalTask } from "./types";

/** Returns a tracker; everything passed to it is disposed of after each test. */
export function disposeAfterEach<Resource>(
  dispose: (resource: Resource) => void,
): (resource: Resource) => Resource {
  const tracked: Resource[] = [];
  afterEach(() => {
    for (const resource of tracked.splice(0)) {
      dispose(resource);
    }
  });
  return (resource) => {
    tracked.push(resource);
    return resource;
  };
}

/** For scenarios that need only a workspace: each is set up in a temp directory removed after each test. */
export function workspaceScenarios(
  tasks: readonly EvalTask[],
  label: string,
): { task: (id: string) => EvalTask; prepared: (id: string) => Promise<string> } {
  const track = disposeAfterEach<string>((workspaceDir) =>
    rmSync(workspaceDir, { recursive: true, force: true }),
  );
  return {
    task: (id) => findTask(tasks, id),
    prepared: async (id) => {
      const workspaceDir = track(mkdtempSync(join(tmpdir(), `${label}-`)));
      await findTask(tasks, id).setup(workspaceDir);
      return workspaceDir;
    },
  };
}
