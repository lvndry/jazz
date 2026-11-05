/**
 * @fileoverview Pure argv builders for the two OS write-confinement backends. Nothing here
 * touches the machine: each takes a `WritePolicy` and the command to run, and returns the argv
 * that runs it with writes fenced to the policy's roots.
 *
 * - macOS `sandbox-exec`: one fixed Seatbelt profile that denies `file-write*` and re-allows
 *   it under numbered parameters. Roots travel as `-D WRITABLE_ROOT_<n>=<path>`, so a path
 *   holding quotes, parentheses or newlines is data to the profile, never profile text, and
 *   there is nothing to escape. `sandbox-exec` applies the profile and `exec`s the command in
 *   place, so the spawned pid is the command's own and its process group is unchanged.
 * - Linux `bwrap`: the whole tree bound read-only, each root bound read-write over it.
 *   Network, PID space and reads are left alone; `--die-with-parent` stops the command with
 *   its parent.
 */

import type { WritePolicy } from "./write-policy";

/** Absolute path, so a `PATH` entry cannot stand in for the sandbox launcher. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Devices a shell writes to as a matter of course; none of them stores data. */
export const SEATBELT_WRITABLE_DEVICES: readonly string[] = [
  "/dev/null",
  "/dev/zero",
  "/dev/tty",
  "/dev/dtracehelper",
];

const SEATBELT_ROOT_PARAMETER_PREFIX = "WRITABLE_ROOT_";

/** The Seatbelt profile for `rootCount` writable roots; the same text for the same count. */
export function seatbeltProfile(rootCount: number): string {
  const devices = SEATBELT_WRITABLE_DEVICES.map((device) => `(literal "${device}")`).join(" ");
  const roots = Array.from(
    { length: rootCount },
    (_unused, index) => `(subpath (param "${SEATBELT_ROOT_PARAMETER_PREFIX}${String(index)}"))`,
  ).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${devices}${roots.length > 0 ? ` ${roots}` : ""})`,
  ].join("\n");
}

export function seatbeltArgv(policy: WritePolicy, argv: readonly string[]): string[] {
  const parameters = policy.roots.flatMap((root, index) => [
    "-D",
    `${SEATBELT_ROOT_PARAMETER_PREFIX}${String(index)}=${root}`,
  ]);
  return [SANDBOX_EXEC_PATH, ...parameters, "-p", seatbeltProfile(policy.roots.length), ...argv];
}

/** How `/dev` is provided inside bwrap: a fresh minimal one, or the host's when the kernel refuses that. */
export type BwrapDeviceMode = "minimal" | "host";

export function bwrapArgv(
  bwrapPath: string,
  policy: WritePolicy,
  argv: readonly string[],
  devices: BwrapDeviceMode,
): string[] {
  const deviceArgs = devices === "minimal" ? ["--dev", "/dev"] : ["--dev-bind", "/dev", "/dev"];
  const rootArgs = policy.roots.flatMap((root) => ["--bind", root, root]);
  return [
    bwrapPath,
    "--ro-bind",
    "/",
    "/",
    ...deviceArgs,
    ...rootArgs,
    "--die-with-parent",
    "--",
    ...argv,
  ];
}
