/**
 * ChatGPT subscription sign-in: the OAuth flows the Codex CLI uses, which OpenAI supports for
 * third-party agents so a Plus/Pro plan can pay for model calls instead of API credits.
 *
 * Two ways in: a browser redirect to a loopback listener, and a device code for machines without
 * a browser (SSH sessions, bot hosts). Both end in the same token exchange.
 */

import { createHash, randomBytes } from "node:crypto";
import { openBrowser, startLoopbackListener } from "@/adapters/oauth/loopback";

/** Codex CLI's public OAuth client. Sign-in only works with this id and its registered redirects. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const SCOPE = "openid profile email offline_access";

/** The only loopback redirect registered for the Codex client, so the port is not negotiable. */
const BROWSER_CALLBACK_PORT = 1455;
const BROWSER_REDIRECT_URI = `http://localhost:${BROWSER_CALLBACK_PORT}/auth/callback`;
const BROWSER_CALLBACK_TIMEOUT_MS = 300_000;

const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
/** OpenAI expires an unclaimed device code after 15 minutes. */
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
/** RFC 8628 §3.5: a `slow_down` response adds five seconds to the polling interval. */
const DEVICE_SLOW_DOWN_INCREMENT_MS = 5_000;

/** Namespace under which the access token's claims carry the ChatGPT account. */
const AUTH_CLAIM = "https://api.openai.com/auth";

/** Sent as `originator` so OpenAI can attribute traffic to Jazz. */
export const CHATGPT_ORIGINATOR = "jazz";

export interface ChatGPTCredential {
  readonly access: string;
  readonly refresh: string;
  /** Access-token expiry, epoch milliseconds. */
  readonly expires: number;
  readonly accountId: string;
  readonly plan?: string;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface AccessTokenClaims {
  readonly accountId?: string;
  readonly plan?: string;
}

/** Read the ChatGPT account and plan from an access token without verifying it. */
export function readAccessTokenClaims(accessToken: string): AccessTokenClaims {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) {
    return {};
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<
      string,
      unknown
    >;
    const auth = claims[AUTH_CLAIM] as
      { chatgpt_account_id?: unknown; chatgpt_plan_type?: unknown } | undefined;
    return {
      ...(typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id.length > 0
        ? { accountId: auth.chatgpt_account_id }
        : {}),
      ...(typeof auth?.chatgpt_plan_type === "string" ? { plan: auth.chatgpt_plan_type } : {}),
    };
  } catch {
    return {};
  }
}

/** The token endpoint refused the grant: the code or refresh token is no longer valid. */
export class ChatGPTTokenRejectedError extends Error {
  readonly status: number;

  constructor(operation: string, status: number, body: string) {
    super(`ChatGPT token ${operation} failed (${status})${body ? `: ${body}` : ""}`);
    this.name = "ChatGPTTokenRejectedError";
    this.status = status;
  }
}

async function readTokenResponse(
  response: Response,
  operation: string,
): Promise<ChatGPTCredential> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ChatGPTTokenRejectedError(operation, response.status, body);
  }
  const json = (await response.json()) as TokenResponse | null;
  if (
    typeof json?.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error(`ChatGPT token ${operation} response is missing fields`);
  }
  const claims = readAccessTokenClaims(json.access_token);
  if (claims.accountId === undefined) {
    throw new Error(
      "This OpenAI login has no ChatGPT account attached. Sign in with the account that holds your ChatGPT plan.",
    );
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: claims.accountId,
    ...(claims.plan !== undefined ? { plan: claims.plan } : {}),
  };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<ChatGPTCredential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  return readTokenResponse(response, "exchange");
}

/** Trade a refresh token for a new credential. OpenAI rotates the refresh token on every call. */
export async function refreshChatGPTCredential(refreshToken: string): Promise<ChatGPTCredential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  return readTokenResponse(response, "refresh");
}

/**
 * Sign in through the browser. Resolves once the loopback listener receives the code and it has
 * been exchanged.
 *
 * @param onAuthorizationUrl - Called before the browser opens, so the caller can print the URL
 *   for when the browser does not open by itself.
 */
export async function signInWithBrowser(
  onAuthorizationUrl: (url: string) => void,
): Promise<ChatGPTCredential> {
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(16));
  const listener = await startLoopbackListener({
    ports: [BROWSER_CALLBACK_PORT],
    expectedState: state,
    timeoutMs: BROWSER_CALLBACK_TIMEOUT_MS,
  });

  try {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", BROWSER_REDIRECT_URI);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", CHATGPT_ORIGINATOR);

    onAuthorizationUrl(url.toString());
    openBrowser(url.toString());

    const code = await listener.waitForCode();
    return await exchangeAuthorizationCode(code, verifier, BROWSER_REDIRECT_URI);
  } finally {
    listener.close();
  }
}

export interface DeviceCodePrompt {
  readonly userCode: string;
  readonly verificationUri: string;
}

interface DeviceAuthorization {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly intervalMs: number;
}

async function requestDeviceCode(): Promise<DeviceAuthorization> {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `ChatGPT device code request failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  const json = (await response.json()) as {
    device_auth_id?: unknown;
    user_code?: unknown;
    interval?: unknown;
  } | null;
  const intervalSeconds =
    typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
  if (
    typeof json?.device_auth_id !== "string" ||
    typeof json.user_code !== "string" ||
    typeof intervalSeconds !== "number" ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 0
  ) {
    throw new Error("ChatGPT device code response is malformed");
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalMs: intervalSeconds * 1000,
  };
}

type DevicePollResult =
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "complete"; readonly code: string; readonly verifier: string };

async function pollDeviceCode(device: DeviceAuthorization): Promise<DevicePollResult> {
  const response = await fetch(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
  });

  if (response.ok) {
    const json = (await response.json()) as {
      authorization_code?: unknown;
      code_verifier?: unknown;
    } | null;
    if (typeof json?.authorization_code !== "string" || typeof json.code_verifier !== "string") {
      throw new Error("ChatGPT device authorization response is malformed");
    }
    return { status: "complete", code: json.authorization_code, verifier: json.code_verifier };
  }

  // The endpoint answers 403/404 until the user has entered the code.
  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }

  const body = await response.text().catch(() => "");
  let errorCode: unknown;
  try {
    const error = (JSON.parse(body) as { error?: string | { code?: string } } | null)?.error;
    errorCode = typeof error === "object" ? error?.code : error;
  } catch {
    errorCode = undefined;
  }
  if (errorCode === "deviceauth_authorization_pending") {
    return { status: "pending" };
  }
  if (errorCode === "slow_down") {
    return { status: "slow_down" };
  }
  throw new Error(
    `ChatGPT device authorization failed (${response.status})${body ? `: ${body}` : ""}`,
  );
}

/**
 * Sign in with a device code: the user opens the verification page on any device and enters the
 * code shown. Resolves once they approve, or rejects after the code expires.
 */
export async function signInWithDeviceCode(
  onUserCode: (prompt: DeviceCodePrompt) => void,
): Promise<ChatGPTCredential> {
  const device = await requestDeviceCode();
  onUserCode({ userCode: device.userCode, verificationUri: DEVICE_VERIFICATION_URI });

  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS;
  let intervalMs = device.intervalMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const result = await pollDeviceCode(device);
    if (result.status === "complete") {
      return exchangeAuthorizationCode(result.code, result.verifier, DEVICE_REDIRECT_URI);
    }
    if (result.status === "slow_down") {
      intervalMs += DEVICE_SLOW_DOWN_INCREMENT_MS;
    }
  }
  throw new Error("The ChatGPT device code expired before it was approved. Start sign-in again.");
}
