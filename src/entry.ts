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

void import("./main").catch((error) => {
  console.error("Fatal error:", error);
  throw error;
});
