/**
 * CLI bootstrap entrypoint.
 *
 * This file runs before the rest of the app is loaded so we can configure the
 * Node.js process (e.g. suppress known noisy deprecation warnings) prior to
 * importing the main CLI module and its dependency tree.
 */

void (async () => {
  /**
   * The npm-published `jazz` bin runs under `#!/usr/bin/env node` so a plain
   * `npm i -g jazz-ai` install (no Bun required) keeps working. But OpenTUI's
   * fullscreen renderer only has a working native FFI backend under Bun —
   * under Node it always falls back to plain output. A `bun i -g jazz-ai`
   * install has Bun available and gets no benefit from that fallback, so when
   * we're not already running under Bun, re-exec this same script through
   * `bun` if it's on PATH. Node-only installs (no Bun on PATH) fall straight
   * through to plain mode — see the notice below for the other lever a user
   * on Node 26.1+ has (`--experimental-ffi`), which we tell them about but
   * deliberately never flip on ourselves: it is an experimental, unstable
   * Node flag, not something to silently change process behavior with.
   */
  if (typeof process.versions.bun !== "string") {
    const { spawnSync } = await import("node:child_process");
    const scriptArgs = [process.argv[1] ?? "", ...process.argv.slice(2)];

    const bunResult = spawnSync("bun", scriptArgs, { stdio: "inherit" });
    const bunSpawnError = bunResult.error as NodeJS.ErrnoException | undefined;
    if (bunSpawnError === undefined || bunSpawnError.code !== "ENOENT") {
      process.exit(bunResult.status ?? 1);
    }

    const experimentalFfiActive =
      process.execArgv.includes("--experimental-ffi") ||
      (process.env["NODE_OPTIONS"] ?? "").includes("--experimental-ffi");
    if (!experimentalFfiActive && process.stdout.isTTY === true && process.stdin.isTTY === true) {
      await warnAboutMissingFullscreenRuntimeOnce();
    }
  }

  // Suppress DeprecationWarning output (including Node's `punycode` warning
  // coming from transitive dependencies on newer Node versions).
  process.noDeprecation = true;

  // Node's `fetch` ignores HTTP_PROXY/HTTPS_PROXY, so on a proxied network every
  // outbound request Jazz makes fails until a dispatcher is installed for them.
  // This has to happen before the CLI module tree loads and issues its first one.
  const { installProxyFromEnvironmentAndWarn } = await import("./core/utils/proxy");
  await installProxyFromEnvironmentAndWarn();

  await import("./main");
})().catch((error) => {
  console.error("Fatal error:", error);
  throw error;
});

/**
 * Tells a Node-only user, once, how to get the fullscreen interface — never
 * flips anything on for them. The marker lives next to the rest of Jazz's
 * user data so the notice survives across invocations but doesn't nag forever.
 */
async function warnAboutMissingFullscreenRuntimeOnce(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { getJazzHomeDirectory } = await import("./core/utils/paths");

  const markerPath = path.join(getJazzHomeDirectory(), ".fullscreen-runtime-notice-shown");
  if (fs.existsSync(markerPath)) return;

  process.stderr.write(
    "jazz: running under Node without Bun — using the standard interface instead of fullscreen.\n" +
      "  For fullscreen, either install Bun (https://bun.sh) or re-run Jazz under Node 26.1+\n" +
      "  with the --experimental-ffi flag yourself, e.g. `node --experimental-ffi $(which jazz)`.\n" +
      "  (This notice won't show again.)\n\n",
  );

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
  } catch {
    // Best-effort: if this can't be written, the notice just shows again next time.
  }
}
