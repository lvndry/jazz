/**
 * @fileoverview Turning a requested confinement mode, a policy and a probed backend into the
 * argv a command runs with, or into a refusal. This is the one place that decides "confined,
 * unconfined, or refuse", and it never returns an unconfined launch for a run that asked for
 * confinement: when the backend cannot provide it, the answer is a `refused` plan carrying the
 * reason and the remedy, which the caller surfaces instead of running the command.
 *
 * `resolveConfinementMode` picks the mode: the operator's `shell.confinement` setting when
 * there is one, otherwise `off` for an attended run (a person at the terminal) and `on` for
 * every other (a bridge bot, a peer, a daemon goal or loop, a headless `jazz run`).
 */

import { existsSync } from "node:fs";
import type { ConfinementBackend, ConfinementLevel, ConfinementStatus } from "./backend";
import { bwrapArgv, seatbeltArgv } from "./launchers";
import type { WriteConfinementMode, WritePolicy } from "./write-policy";

export function resolveConfinementMode(
  configured: WriteConfinementMode | undefined,
  attended: boolean,
): WriteConfinementMode {
  return configured ?? (attended ? "off" : "on");
}

export type LaunchPlan =
  | { readonly kind: "unconfined" }
  | {
      readonly kind: "confined";
      readonly argv: readonly string[];
      readonly level: ConfinementLevel;
      readonly backend: ConfinementBackend;
    }
  | { readonly kind: "refused"; readonly message: string };

export function refusalMessage(status: ConfinementStatus): string {
  return [
    `Write confinement is on, but this machine cannot provide it: ${status.reason ?? "no backend available"}.`,
    "The command was not run.",
    status.remedy ?? "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** The launch for `argv` under `mode`; never `unconfined` unless `mode` is `off`. */
export function planLaunch(input: {
  readonly mode: WriteConfinementMode;
  readonly policy: WritePolicy;
  readonly argv: readonly string[];
  readonly status: ConfinementStatus;
}): LaunchPlan {
  if (input.mode === "off") {
    return { kind: "unconfined" };
  }
  const { status } = input;
  if (status.level === "none" || status.backend === "none") {
    return { kind: "refused", message: refusalMessage(status) };
  }
  if (status.backend === "seatbelt") {
    return {
      kind: "confined",
      argv: seatbeltArgv(input.policy, input.argv),
      level: status.level,
      backend: status.backend,
    };
  }
  const bwrapPath = status.bwrapPath;
  if (bwrapPath === undefined) {
    return { kind: "refused", message: refusalMessage(status) };
  }
  const existingRoots = { roots: input.policy.roots.filter((root) => existsSync(root)) };
  return {
    kind: "confined",
    argv: bwrapArgv(bwrapPath, existingRoots, input.argv, status.devices ?? "minimal"),
    level: status.level,
    backend: status.backend,
  };
}
