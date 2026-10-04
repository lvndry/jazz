/**
 * Records the module-load order of a startup so bytecode can be compiled in
 * that order.
 *
 * Bun can compile module bytecode in the order it is actually loaded at
 * startup instead of bundle order, which shortens cold start. That needs two
 * artifacts and a round trip through a real binary:
 *
 *   1. a binary built the normal way (`bun run build:binary`),
 *   2. this script: it runs that binary with `BUN_BYTECODE_ORDER_OUT` set, and
 *      the runtime writes the observed load order to `.build/startup.order`,
 *   3. a rebuild — `buildStandaloneBinary` picks the order file up
 *      automatically.
 *
 * Only Bun releases that implement bytecode-ordering record it (1.4.3
 * canary at the time of writing). On earlier releases the run succeeds but
 * writes nothing, and this script says so and leaves the old order file (if
 * any) in place.
 *
 * Usage:
 *   bun run scripts/record-startup-order.ts            # profiles `--version`
 *   bun run scripts/record-startup-order.ts -- --help  # profiles another invocation
 *
 * The profiled invocation should be representative of how people actually
 * start the CLI. A `JAZZ_HOME` under `.build/` is used by default so the run
 * does not touch the user's real agents or conversations.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPILE_TARGETS, STARTUP_ORDER_FILE } from "./build-helpers";

const argIndex = process.argv.indexOf("--");
const extraArgs = argIndex === -1 ? [] : process.argv.slice(argIndex + 1);

const compileTarget = `bun-${process.platform}-${process.arch}` as Bun.Build.CompileTarget;
const binaryName = COMPILE_TARGETS[compileTarget] ?? `jazz-${process.platform}-${process.arch}`;
// Absolute: the run below happens in a throwaway JAZZ_HOME, and a relative
// path would resolve against that instead of the repo root.
const binaryPath = path.resolve("deploy", "binaries", binaryName);
if (!fs.existsSync(binaryPath)) {
  process.stderr.write(`No binary at ${binaryPath} — run \`bun run build:binary\` first.\n`);
  process.exit(1);
}

const orderPath = path.resolve(STARTUP_ORDER_FILE);
const previous = fs.existsSync(orderPath) ? fs.statSync(orderPath) : undefined;
fs.rmSync(orderPath, { force: true });

const profiledHome = path.join(os.tmpdir(), `jazz-order-${process.pid}`);
fs.rmSync(profiledHome, { recursive: true, force: true });
fs.mkdirSync(profiledHome, { recursive: true });
fs.writeFileSync(
  path.join(profiledHome, "config.json"),
  JSON.stringify({ notifications: { enabled: false } }),
);
fs.mkdirSync(path.join(profiledHome, "agents"), { recursive: true });

try {
  const run = Bun.spawnSync([binaryPath, ...extraArgs], {
    cwd: profiledHome,
    env: {
      ...process.env,
      JAZZ_HOME: profiledHome,
      JAZZ_OFFLINE: "1",
      JAZZ_DISABLE_KEYRING: "1",
      JAZZ_DISABLE_UPDATE_CHECK: "1",
      JAZZ_DISABLE_CATCH_UP: "1",
      BUN_BYTECODE_ORDER_OUT: orderPath,
    },
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (run.exitCode !== 0) {
    process.stderr.write(
      `Profiled run exited ${run.exitCode}:\n${new TextDecoder().decode(run.stderr)}\n`,
    );
  }
} finally {
  fs.rmSync(profiledHome, { recursive: true, force: true });
}

if (!fs.existsSync(orderPath)) {
  const message = `This Bun (${Bun.version}) did not record a load order — bytecode-ordering is not implemented yet.`;
  if (previous !== undefined) {
    process.stdout.write(
      `${message}\nKept the existing ${STARTUP_ORDER_FILE} (${(previous.size / 1024).toFixed(0)} KB).\n`,
    );
  } else {
    process.stdout.write(`${message}\nNo order file written; rebuilds will not apply one.\n`);
  }
  process.exit(0);
}

process.stdout.write(
  `Recorded ${STARTUP_ORDER_FILE} (${(fs.statSync(orderPath).size / 1024).toFixed(0)} KB).\n` +
    "Rebuild with `bun run build:binary` to apply it; the build prints `bytecode order:` when it does.\n",
);
