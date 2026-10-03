/**
 * The operator's consent to computer use: one acknowledgement, and a grant per app.
 *
 * Only the `jazz computer` commands write this file, and they refuse to run inside a process a
 * Jazz agent started. No tool grants or revokes, and the agent's file tools treat everything
 * under `$JAZZ_HOME/computer` as Jazz's own state, which they ask about under every policy.
 *
 * A grant names one app by bundle id and is absolute-expiring: once `expiresAt` passes it covers
 * nothing. `idleTimeoutMs` ends a run's access after that long without an action, so a session
 * left open does not keep an app reachable. Grants are read again before every action, so a
 * revoke takes effect on the very next one.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { writeJsonFileDurably } from "@/core/utils/durable-file";
import { withFileLock } from "@/core/utils/file-lock";
import { getJazzHomeDirectory } from "@/core/utils/paths";

/** How long a grant lasts when the operator does not say: one working day. */
export const DEFAULT_GRANT_EXPIRY_MS = 8 * 60 * 60 * 1000;

/** How long a run may sit idle before its access to every app ends: half an hour. */
export const DEFAULT_GRANT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const SHA256_HEX_LENGTH = 64;

const grantSchema = z
  .object({
    bundleId: z.string().min(1),
    name: z.string().min(1).optional(),
    grantedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    idleTimeoutMs: z.number().int().positive(),
    foreground: z.boolean(),
  })
  .strict();

const acknowledgementSchema = z
  .object({
    acknowledgedAt: z.number().int().nonnegative(),
    driverPath: z.string().min(1),
    driverSha256: z.string().length(SHA256_HEX_LENGTH),
  })
  .strict();

const computerStateSchema = z
  .object({
    version: z.literal(1),
    acknowledgement: acknowledgementSchema.optional(),
    grants: z.array(grantSchema),
  })
  .strict();

export type ComputerGrant = z.infer<typeof grantSchema>;

export type ComputerAcknowledgement = z.infer<typeof acknowledgementSchema>;

export type ComputerState = z.infer<typeof computerStateSchema>;

export const EMPTY_COMPUTER_STATE: ComputerState = { version: 1, grants: [] };

export function computerDirectory(): string {
  return path.join(getJazzHomeDirectory(), "computer");
}

export function grantsFilePath(): string {
  return path.join(computerDirectory(), "grants.json");
}

function grantsLockPath(): string {
  return path.join(computerDirectory(), ".grants.lock");
}

/**
 * The stored state. A missing or unreadable file reads as nothing acknowledged and nothing
 * granted, which is the safe answer, so callers never need to handle a read error.
 */
export async function readComputerState(): Promise<ComputerState> {
  try {
    const parsed = computerStateSchema.safeParse(
      JSON.parse(await readFile(grantsFilePath(), "utf8")),
    );
    return parsed.success ? parsed.data : EMPTY_COMPUTER_STATE;
  } catch {
    return EMPTY_COMPUTER_STATE;
  }
}

/** Rewrite the state under a lock, so a grant and a revoke from two terminals cannot interleave. */
export async function updateComputerState(
  update: (state: ComputerState) => ComputerState,
): Promise<ComputerState> {
  return withFileLock(grantsLockPath(), async () => {
    const next = update(await readComputerState());
    await writeJsonFileDurably(grantsFilePath(), next);
    return next;
  });
}

export function isGrantActive(grant: ComputerGrant, now: number): boolean {
  return now < grant.expiresAt;
}

export function activeGrants(state: ComputerState, now: number): readonly ComputerGrant[] {
  return state.grants.filter((grant) => isGrantActive(grant, now));
}

export function findActiveGrant(
  state: ComputerState,
  bundleId: string,
  now: number,
): ComputerGrant | undefined {
  return activeGrants(state, now).find((grant) => grant.bundleId === bundleId);
}

/** The state with `grant` added, replacing any earlier grant for the same app. */
export function withGrant(state: ComputerState, grant: ComputerGrant): ComputerState {
  return {
    ...state,
    grants: [...state.grants.filter((existing) => existing.bundleId !== grant.bundleId), grant],
  };
}

export function withoutGrant(state: ComputerState, bundleId: string): ComputerState {
  return { ...state, grants: state.grants.filter((grant) => grant.bundleId !== bundleId) };
}

export function withAcknowledgement(
  state: ComputerState,
  acknowledgement: ComputerAcknowledgement,
): ComputerState {
  return { ...state, acknowledgement };
}

/**
 * The shortest idle timeout among the active grants, which bounds how long a run may sit idle:
 * an app with a short timeout is never kept reachable by another app's longer one.
 */
export function shortestIdleTimeoutMs(grants: readonly ComputerGrant[]): number {
  return grants.length === 0
    ? DEFAULT_GRANT_IDLE_TIMEOUT_MS
    : Math.min(...grants.map((grant) => grant.idleTimeoutMs));
}
