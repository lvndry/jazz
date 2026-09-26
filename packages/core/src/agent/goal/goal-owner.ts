/**
 * @fileoverview Stable ownership identity for durable goals.
 *
 * Goal records are created by the interactive CLI and advanced by the daemon, often in
 * different processes. This module derives one installation identity from the host and Jazz
 * home path so both processes can list and control the same records, while goal APIs can
 * reject records owned by a different Jazz installation. Use {@link getGoalOwnerInstanceId}
 * whenever a caller creates or scopes access to a locally owned goal.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { getJazzHomeDirectory } from "@/core/utils/paths";

export function getGoalOwnerInstanceId(): string {
  return createHash("sha256").update(`${hostname()}\0${getJazzHomeDirectory()}`).digest("hex");
}
