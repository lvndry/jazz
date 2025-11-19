import os from "node:os";
import path from "node:path";

/**
 * Runtime detection utilities for determining execution context
 */

/**
 * Detect if the CLI is running from a global npm/pnpm/bun/yarn installation
 *
 * This is useful for determining whether to use user-specific directories
 * (like ~/.jazz/logs) or local development directories (like ./logs)
 *
 * @returns true if running from a global package installation, false otherwise
 *
 * @example
 * ```typescript
 * if (isInstalledGlobally()) {
 *   // Use ~/.jazz/logs for production
 * } else {
 *   // Use ./logs for development
 * }
 * ```
 */
export function isInstalledGlobally(): boolean {
  // Get the directory where the current script is located
  const scriptPath = __dirname;

  // Common global installation paths for different package managers
  const globalPaths = [
    // npm global paths
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    path.join(os.homedir(), ".npm-global"),
    path.join(os.homedir(), ".npm-packages"),
    // pnpm global paths
    path.join(os.homedir(), ".local/share/pnpm"),
    path.join(os.homedir(), ".pnpm-global"),
    // bun global paths
    path.join(os.homedir(), ".bun/install/global"),
    // yarn global paths
    path.join(os.homedir(), ".yarn/bin"),
    path.join(os.homedir(), ".config/yarn/global"),
  ];

  // Check if script path contains any global installation directory
  // Also check for 'node_modules' in path but not in current working directory
  // (indicates installed package vs local development)
  const isInGlobalPath = globalPaths.some((globalPath) => scriptPath.includes(globalPath));
  const isInNodeModules = scriptPath.includes("node_modules") && !scriptPath.startsWith(process.cwd());

  return isInGlobalPath || isInNodeModules;
}

/**
 * Check if running in development mode
 *
 * @returns true if running in local development, false if in production/global install
 */
export function isDevelopmentMode(): boolean {
  return !isInstalledGlobally();
}

/**
 * Resolve the default directory where Jazz should persist user data
 * Falls back to the current working directory when not installed globally
 */
export function getDefaultDataDirectory(): string {
  if (isInstalledGlobally()) {
    const homeDir = os.homedir();
    if (homeDir && homeDir.trim().length > 0) {
      return path.join(homeDir, ".jazz");
    }
  }

  return path.resolve(process.cwd(), ".jazz");
}
