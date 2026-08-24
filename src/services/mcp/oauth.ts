import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Effect } from "effect";
import {
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringSet,
} from "@/services/secrets/keyring";

/** Client name advertised to authorization servers during dynamic registration. */
const CLIENT_NAME = "Jazz";
const CLIENT_URI = "https://github.com/lvndry/jazz";

/**
 * How long the loopback listener waits for the browser to come back with a
 * code before giving up. Long enough to cover a fresh login plus consent on a
 * provider the user is not already signed into.
 */
const CALLBACK_TIMEOUT_MS = 300_000;

/** Keyring account names. Namespaced so a server called `tokens` cannot collide. */
function tokensAccount(serverName: string): string {
  return `mcp.oauth.${serverName}.tokens`;
}

function clientAccount(serverName: string): string {
  return `mcp.oauth.${serverName}.client`;
}

/**
 * Raised when a server needs the interactive browser flow but the caller is a
 * context that must not open one — an agent run, or an unattended bridge.
 * The message names the command that fixes it.
 */
export class InteractiveAuthRequiredError extends Error {
  readonly serverName: string;

  constructor(serverName: string) {
    super(`MCP server "${serverName}" requires authorization. Run: jazz mcp auth ${serverName}`);
    this.name = "InteractiveAuthRequiredError";
    this.serverName = serverName;
  }
}

function readJson<T>(raw: string | undefined): T | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Read/write halves shared by the interactive and non-interactive providers. */
function createStorage(serverName: string) {
  return {
    async loadTokens(): Promise<OAuthTokens | undefined> {
      const backend = await Effect.runPromise(detectKeyringBackend());
      const raw = await Effect.runPromise(keyringGet(backend, tokensAccount(serverName)));
      return readJson<OAuthTokens>(raw);
    },
    async saveTokens(tokens: OAuthTokens): Promise<void> {
      const backend = await Effect.runPromise(detectKeyringBackend());
      await Effect.runPromise(
        keyringSet(backend, tokensAccount(serverName), JSON.stringify(tokens)),
      );
    },
    async loadClient(): Promise<OAuthClientInformation | undefined> {
      const backend = await Effect.runPromise(detectKeyringBackend());
      const raw = await Effect.runPromise(keyringGet(backend, clientAccount(serverName)));
      return readJson<OAuthClientInformation>(raw);
    },
    async saveClient(info: OAuthClientInformationFull): Promise<void> {
      const backend = await Effect.runPromise(detectKeyringBackend());
      await Effect.runPromise(keyringSet(backend, clientAccount(serverName), JSON.stringify(info)));
    },
  };
}

function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: CLIENT_NAME,
    client_uri: CLIENT_URI,
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * Provider used on the connect path.
 *
 * Reads stored tokens and lets the SDK refresh them, but refuses to start a
 * browser flow: connecting happens inside agent runs and unattended bridges,
 * where opening a browser would be wrong. A server that needs fresh consent
 * surfaces `InteractiveAuthRequiredError` instead.
 */
export function createStoredTokenProvider(serverName: string): OAuthClientProvider {
  const storage = createStorage(serverName);
  // Placeholder: only used to shape the registration request when a stored
  // client exists. A provider that reaches registration is already on its way
  // to `redirectToAuthorization`, which throws.
  const redirectUrl = "http://127.0.0.1/callback";
  let codeVerifierValue: string | undefined;

  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata(redirectUrl);
    },
    clientInformation: () => storage.loadClient(),
    saveClientInformation: (info) => storage.saveClient(info as OAuthClientInformationFull),
    tokens: () => storage.loadTokens(),
    saveTokens: (tokens) => storage.saveTokens(tokens),
    redirectToAuthorization: () => {
      throw new InteractiveAuthRequiredError(serverName);
    },
    saveCodeVerifier: (verifier) => {
      codeVerifierValue = verifier;
    },
    codeVerifier: () => {
      if (codeVerifierValue === undefined) {
        throw new InteractiveAuthRequiredError(serverName);
      }
      return codeVerifierValue;
    },
    invalidateCredentials: async (scope) => {
      const backend = await Effect.runPromise(detectKeyringBackend());
      if (scope === "all" || scope === "tokens") {
        await Effect.runPromise(keyringDelete(backend, tokensAccount(serverName)));
      }
      if (scope === "all" || scope === "client") {
        await Effect.runPromise(keyringDelete(backend, clientAccount(serverName)));
      }
      if (scope === "verifier") {
        codeVerifierValue = undefined;
      }
    },
  };
}

/** Open a URL in the user's default browser, best-effort. */
function openBrowser(url: string): void {
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

interface CallbackListener {
  readonly redirectUrl: string;
  readonly waitForCode: () => Promise<string>;
  readonly close: () => void;
}

/**
 * Bind a loopback listener on an ephemeral port and resolve the first
 * `?code=` it receives.
 *
 * The port has to exist before the provider is built, because it is part of
 * the redirect URI that gets registered with the authorization server.
 */
function startCallbackListener(expectedState: string): Promise<CallbackListener> {
  return new Promise((resolve, reject) => {
    let onCode: ((code: string) => void) | undefined;
    let onFailure: ((error: Error) => void) | undefined;
    let received: string | undefined;
    let failure: Error | undefined;

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");

      if (error !== null) {
        const authError = new Error(
          `Authorization failed: ${url.searchParams.get("error_description") ?? error}`,
        );
        failure = authError;
        onFailure?.(authError);
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
        const stateError = new Error("Authorization failed: state parameter did not match");
        failure = stateError;
        onFailure?.(stateError);
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("State mismatch. Return to your terminal.");
        return;
      }

      received = code;
      onCode?.(code);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(SUCCESS_PAGE);
    });

    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not bind a loopback port for the OAuth callback"));
        return;
      }

      resolve({
        redirectUrl: `http://127.0.0.1:${address.port}/callback`,
        waitForCode: () =>
          new Promise<string>((resolveCode, rejectCode) => {
            if (received !== undefined) return resolveCode(received);
            if (failure !== undefined) return rejectCode(failure);
            const timer = setTimeout(() => {
              rejectCode(new Error("Timed out waiting for the browser to complete authorization"));
            }, CALLBACK_TIMEOUT_MS);
            onCode = (code) => {
              clearTimeout(timer);
              resolveCode(code);
            };
            onFailure = (error) => {
              clearTimeout(timer);
              rejectCode(error);
            };
          }),
        close: () => server.close(),
      });
    });
  });
}

/**
 * Run the full OAuth 2.1 authorization-code flow with PKCE for one server.
 *
 * Discovery, dynamic client registration, and the token exchange are the SDK's;
 * this supplies the loopback redirect, the browser hand-off, and keyring
 * persistence. Resolves once tokens are stored.
 *
 * @param onAuthorizationUrl - Called with the URL before the browser opens, so
 *   the caller can print it for a headless or remote session.
 */
export function authorizeServer(
  serverName: string,
  serverUrl: string,
  onAuthorizationUrl: (url: string) => void,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      const storage = createStorage(serverName);
      const state = crypto.randomUUID();
      const listener = await startCallbackListener(state);
      let codeVerifierValue: string | undefined;

      try {
        const provider: OAuthClientProvider = {
          get redirectUrl() {
            return listener.redirectUrl;
          },
          get clientMetadata() {
            return clientMetadata(listener.redirectUrl);
          },
          state: () => state,
          clientInformation: () => storage.loadClient(),
          saveClientInformation: (info) => storage.saveClient(info as OAuthClientInformationFull),
          tokens: () => storage.loadTokens(),
          saveTokens: (tokens) => storage.saveTokens(tokens),
          redirectToAuthorization: (authorizationUrl: URL) => {
            onAuthorizationUrl(authorizationUrl.toString());
            openBrowser(authorizationUrl.toString());
          },
          saveCodeVerifier: (verifier: string) => {
            codeVerifierValue = verifier;
          },
          codeVerifier: () => {
            if (codeVerifierValue === undefined) {
              throw new Error("No PKCE code verifier available for this flow");
            }
            return codeVerifierValue;
          },
        };

        const result = await auth(provider, { serverUrl });

        if (result === "AUTHORIZED") {
          return;
        }

        const authorizationCode = await listener.waitForCode();
        const exchanged = await auth(provider, { serverUrl, authorizationCode });

        if (exchanged !== "AUTHORIZED") {
          throw new Error("Authorization did not complete");
        }
      } finally {
        listener.close();
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

/** Forget stored tokens and registration for one server. */
export function clearServerAuth(serverName: string): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const backend = yield* detectKeyringBackend();
    yield* keyringDelete(backend, tokensAccount(serverName));
    yield* keyringDelete(backend, clientAccount(serverName));
  });
}

/** Whether stored tokens exist for a server (does not check expiry). */
export function hasStoredAuth(serverName: string): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const backend = yield* detectKeyringBackend();
    const raw = yield* keyringGet(backend, tokensAccount(serverName));
    return readJson<OAuthTokens>(raw) !== undefined;
  });
}
