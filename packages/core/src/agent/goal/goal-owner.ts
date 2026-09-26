/**
 * @fileoverview Stable ownership identity for durable goals.
 *
 * Goal records are created by the interactive CLI and advanced by the daemon, often in
 * different processes. Both read one installation id from the Jazz home, so they list and
 * control the same records, while goal APIs reject records owned by a different installation.
 * The id is random and stored once per home: it survives a hostname change, which a derived
 * id would not, and it says nothing about the machine or its paths. Use
 * {@link getGoalOwnerInstanceId} whenever a caller creates or scopes access to a local goal.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getJazzHomeDirectory } from "@/core/utils/paths";

const INSTANCE_ID_FILE = "instance-id";

const idsByHome = new Map<string, string>();

function readInstanceId(path: string): string | undefined {
  try {
    const id = readFileSync(path, "utf8").trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Defaults to this process's Jazz home; only a caller seeding another home passes one. */
export function getGoalOwnerInstanceId(jazzHome: string = getJazzHomeDirectory()): string {
  const home = resolve(jazzHome);
  const cached = idsByHome.get(home);
  if (cached !== undefined) {
    return cached;
  }
  const path = join(home, INSTANCE_ID_FILE);
  let id = readInstanceId(path);
  if (id === undefined) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    id = readInstanceId(path);
    if (id === undefined) {
      throw new Error(`Could not read the Jazz instance id at ${path}.`);
    }
  }
  idsByHome.set(home, id);
  return id;
}
