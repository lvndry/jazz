import { spawn } from "node:child_process";
import { extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** The process state needed to decide whether a local browser is useful. */
export interface CompositionBrowserContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: { readonly isTTY?: boolean };
  readonly stdout: { readonly isTTY?: boolean };
}

/**
 * Browser launching is deliberately kept behind this tiny port. It makes the
 * policy testable without starting a desktop application and guarantees the
 * system implementation never asks a shell to parse a path.
 */
export interface CompositionBrowserLauncher {
  launch(command: string, args: readonly string[]): Promise<void>;
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return env["CI"] === "true" || env["CI"] === "1";
}

/**
 * A bridge identifies itself with `JAZZ_SURFACE`; an absent marker means the
 * local CLI. Browser windows belong to that local CLI alone, not to a bot,
 * daemon, or other remote surface.
 */
export function shouldOpenCompletedComposition(context: CompositionBrowserContext): boolean {
  if (isCi(context.env)) return false;
  if (
    context.platform !== "darwin" &&
    context.platform !== "linux" &&
    context.platform !== "win32"
  ) {
    return false;
  }

  const surface = context.env["JAZZ_SURFACE"]?.trim();
  if (surface !== undefined && surface.length > 0 && surface !== "cli") return false;

  // A browser on a machine with no terminal attached is almost always a daemon,
  // cron job, or headless container. Either stream being a TTY is enough to
  // establish that a local person is present.
  return context.stdin.isTTY === true || context.stdout.isTTY === true;
}

function commandForPlatform(platform: NodeJS.Platform): string | undefined {
  switch (platform) {
    case "darwin":
      return "open";
    case "linux":
      return "xdg-open";
    case "win32":
      // `rundll32` delegates file URLs to the registered default browser without
      // invoking cmd.exe (unlike the usual `start` recipe).
      return "rundll32.exe";
    default:
      return undefined;
  }
}

export function createSystemCompositionBrowserLauncher(): CompositionBrowserLauncher {
  return {
    launch: (command, args) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], {
          detached: true,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }),
  };
}

/**
 * Best-effort opening for a completed, absolute local HTML composition.
 *
 * Returning `false` covers intentionally skipped contexts as well as launch
 * failures: creating the composition remains successful when its optional
 * desktop preview cannot be shown.
 */
export async function openCompletedCompositionInBrowser(
  htmlPath: string,
  context: CompositionBrowserContext = {
    platform: process.platform,
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
  },
  launcher: CompositionBrowserLauncher = createSystemCompositionBrowserLauncher(),
): Promise<boolean> {
  if (!shouldOpenCompletedComposition(context)) return false;
  if (!isAbsolute(htmlPath)) return false;

  const extension = extname(htmlPath).toLowerCase();
  if (extension !== ".html" && extension !== ".htm") return false;

  const command = commandForPlatform(context.platform);
  if (command === undefined) return false;

  const fileUrl = pathToFileURL(htmlPath).href;
  const args = context.platform === "win32" ? ["url.dll,FileProtocolHandler", fileUrl] : [fileUrl];

  try {
    await launcher.launch(command, args);
    return true;
  } catch {
    return false;
  }
}
