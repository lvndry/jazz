/**
 * @fileoverview Stable ownership identity for durable goals.
 *
 * Goal records are created by the interactive CLI and advanced by the daemon, often in
 * different processes. This module derives one installation identity from the host and Jazz
 * home path so both processes can list and control the same records, while goal APIs can
 * reject records owned by a different Jazz installation. Use {@link getGoalOwnerInstanceId}
 * whenever a caller creates or scopes access to a locally owned goal.
 */
import { hostname } from "node:os";
import { resolve } from "node:path";
import { sha256Hex } from "@/core/utils/hash";
import { getJazzHomeDirectory } from "@/core/utils/paths";

/** Defaults to this process's Jazz home; only a caller seeding another home passes one. */
export function getGoalOwnerInstanceId(jazzHome: string = getJazzHomeDirectory()): string {
  return sha256Hex(`${hostname()}\0${resolve(jazzHome)}`);
}
