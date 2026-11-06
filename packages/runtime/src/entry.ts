/**
 * CLI bootstrap entrypoint.
 *
 * This file runs before the rest of the app is loaded so we can configure the
 * Node.js process (e.g. suppress known noisy deprecation warnings) prior to
 * importing the main CLI module and its dependency tree.
 */

// Suppress DeprecationWarning output (including Node's `punycode` warning coming
// from transitive dependencies on newer Node versions).
process.noDeprecation = true;

/**
 * The crash report role for this invocation: `daemon` and `run` by subcommand, `chat` for the
 * bare command and `chat`, `cli` for everything else.
 */
function crashRoleFromArguments(commandArguments: readonly string[]): string {
  const subcommand = commandArguments.find((argument) => !argument.startsWith("-"));
  if (subcommand === undefined || subcommand === "chat") {
    return "chat";
  }
  return subcommand === "daemon" || subcommand === "run" ? subcommand : "cli";
}

void (async () => {
  const { getLogsDirectory } = await import("@jazz/adapters/logger");
  const { installCrashHandlers } = await import("@jazz/core/utils/crash-report");
  installCrashHandlers({
    role: crashRoleFromArguments(process.argv.slice(2)),
    logsDirectory: getLogsDirectory(),
  });

  // Node's `fetch` ignores HTTP_PROXY/HTTPS_PROXY, so on a proxied network every
  // outbound request Jazz makes fails until a dispatcher is installed for them.
  // This has to happen before the CLI module tree loads and issues its first one.
  const { installProxyFromEnvironmentAndWarn } = await import("@jazz/core/utils/proxy");
  await installProxyFromEnvironmentAndWarn();

  await import("./main");
})().catch((error) => {
  console.error("Fatal error:", error);
  throw error;
});
