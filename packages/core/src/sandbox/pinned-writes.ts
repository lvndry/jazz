/**
 * @fileoverview The file tools' hook for a confined mutation: `pinWriteTargets` returns the paths
 * a mutation must use and a last-moment check to run right before it.
 *
 * With confinement off, `paths` is `targets` unchanged and `recheck` always passes. With it on,
 * `denied` is set when a target is outside the writable roots; otherwise `paths` are the pinned
 * real paths (see `pinTargets` in `write-pin.ts`, including the residual race window) and
 * `recheck()` must be yielded immediately before the mutating call, returning a refusal when a
 * checked directory has been swapped since:
 *
 *     const pin = yield* pinWriteTargets(context, [target], { follow: true });
 *     if (pin.denied !== undefined) {
 *       return pin.denied;
 *     }
 *     const swapped = yield* pin.recheck();
 *     if (swapped !== undefined) {
 *       return swapped;
 *     }
 *     yield* mutate(pin.paths[0]);
 *
 * `follow: true` is for a write that goes through a symlink to its target; the default `false`
 * keeps the final path component as the entry itself (remove or rename a link, not its target).
 */

import { Effect } from "effect";
import { FileSystemContextServiceTag } from "@/core/interfaces/fs";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { ToolExecutionContext } from "@/core/types/tools";
import { fsWriteDeniedMessage, writePolicyFor } from "./runtime-policy";
import { pinTargets, recheckPins } from "./write-pin";
import { buildKeyFromContext } from "../agent/tools/context-utils";

export type RefusedWrite = {
  readonly success: false;
  readonly result: null;
  readonly error: string;
};

export function swappedDirectoryMessage(deniedPath: string): string {
  return `Write confinement is on: a directory on the way to ${deniedPath} changed while the write was being prepared, so nothing was written. Run the tool again.`;
}

export function pinWriteTargets(
  context: ToolExecutionContext,
  targets: readonly string[],
  options: { readonly follow?: boolean } = {},
) {
  return Effect.gen(function* () {
    const passThrough = {
      denied: undefined as RefusedWrite | undefined,
      paths: targets,
      recheck: (): Effect.Effect<RefusedWrite | undefined> => Effect.succeed(undefined),
    };
    if (context.shellConfinement !== "on") {
      return passThrough;
    }
    const sessionCwd = yield* (yield* FileSystemContextServiceTag).getCwd(
      buildKeyFromContext(context),
    );
    const policy = writePolicyFor(sessionCwd);
    const logger = yield* Effect.serviceOption(LoggerServiceTag);
    const refuse = (deniedPath: string, stage: "check" | "recheck") =>
      Effect.gen(function* () {
        if (logger._tag === "Some") {
          yield* logger.value.info("File write refused by write confinement", {
            deniedPath,
            sessionCwd,
            stage,
            toolCallId: context.toolCallId,
          });
        }
        const refused: RefusedWrite = {
          success: false,
          result: null,
          error:
            stage === "check"
              ? fsWriteDeniedMessage(deniedPath, sessionCwd)
              : swappedDirectoryMessage(deniedPath),
        };
        return refused;
      });
    const pinned = pinTargets(policy, targets, sessionCwd, options.follow === true);
    if (!pinned.ok) {
      return { ...passThrough, denied: yield* refuse(pinned.deniedPath, "check") };
    }
    return {
      denied: undefined as RefusedWrite | undefined,
      paths: pinned.pins.map((pin) => pin.realPath),
      recheck: (): Effect.Effect<RefusedWrite | undefined> =>
        Effect.gen(function* () {
          const changed = recheckPins(policy, pinned.pins);
          return changed === undefined ? undefined : yield* refuse(changed, "recheck");
        }),
    };
  });
}
