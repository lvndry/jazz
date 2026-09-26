/**
 * Browser hand-off and loopback redirect listener shared by Jazz's OAuth flows (MCP servers,
 * ChatGPT sign-in).
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** Open a URL in the user's default browser, best-effort. */
export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      // Falling back to the printed URL is the whole recovery path.
    });
    child.unref();
  } catch {
    // Same: the caller has already printed the URL.
  }
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Jazz</title>
<body style="font-family:system-ui;padding:3rem;text-align:center">
<h1>Authorized</h1><p>You can close this tab and return to your terminal.</p></body>`;

export interface LoopbackListener {
  /** The port that was bound, one of the offered `ports`. */
  readonly port: number;
  readonly waitForCode: () => Promise<string>;
  /** Settle a pending `waitForCode` with an error, e.g. when a code arrived another way. */
  readonly cancel: (reason: Error) => void;
  readonly close: () => void;
}

export interface LoopbackListenerOptions {
  /**
   * Ports to try in order. OAuth clients registered with fixed redirect URIs only accept these,
   * so the listener never falls back to an ephemeral port.
   */
  readonly ports: readonly number[];
  readonly expectedState: string;
  readonly timeoutMs: number;
}

/**
 * Bind a loopback listener on the first free offered port and resolve the first `?code=` it
 * receives whose `state` matches.
 *
 * The port has to exist before the authorization URL is built, because it is part of the
 * redirect URI.
 */
export function startLoopbackListener(options: LoopbackListenerOptions): Promise<LoopbackListener> {
  const { ports, expectedState, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    let onCode: ((code: string) => void) | undefined;
    let onFailure: ((error: Error) => void) | undefined;
    let received: string | undefined;
    let failure: Error | undefined;

    const fail = (error: Error): void => {
      failure = error;
      onFailure?.(error);
    };

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");

      if (error !== null) {
        fail(
          new Error(`Authorization failed: ${url.searchParams.get("error_description") ?? error}`),
        );
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Authorization failed. Return to your terminal.");
        return;
      }

      if (code === null) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }

      // The state check is what stops a stray request on the loopback port
      // from injecting a code into this flow.
      if (state !== expectedState) {
        fail(new Error("Authorization failed: state parameter did not match"));
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("State mismatch. Return to your terminal.");
        return;
      }

      received = code;
      onCode?.(code);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUCCESS_PAGE);
    });

    // Try the offered ports in order; a busy one is normal when another
    // authorization is already in flight.
    let portIndex = 0;
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && portIndex < ports.length - 1) {
        portIndex += 1;
        server.listen(ports[portIndex], "127.0.0.1");
        return;
      }
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `OAuth callback ${ports.length === 1 ? "port" : "ports"} already in use (${ports.join(", ")}). Finish or cancel the other authorization and try again.`,
            )
          : error,
      );
    });

    server.listen(ports[portIndex], "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not bind a loopback port for the OAuth callback"));
        return;
      }

      resolve({
        port: address.port,
        waitForCode: () =>
          new Promise<string>((resolveCode, rejectCode) => {
            if (received !== undefined) {
              resolveCode(received);
              return;
            }
            if (failure !== undefined) {
              rejectCode(failure);
              return;
            }
            const timer = setTimeout(() => {
              rejectCode(new Error("Timed out waiting for the browser to complete authorization"));
            }, timeoutMs);
            onCode = (code) => {
              clearTimeout(timer);
              resolveCode(code);
            };
            onFailure = (error) => {
              clearTimeout(timer);
              rejectCode(error);
            };
          }),
        cancel: fail,
        close: () => server.close(),
      });
    });
  });
}
