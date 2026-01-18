/**
 * Shared Google OAuth authentication utilities and types
 */

/**
 * Google OAuth token structure
 */
export interface GoogleOAuthToken {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

/**
 * Google OAuth scopes for Gmail and Calendar services
 */
export const GOOGLE_OAUTH_SCOPES = {
  GMAIL: {
    READONLY: "https://www.googleapis.com/auth/gmail.readonly",
    SEND: "https://www.googleapis.com/auth/gmail.send",
    MODIFY: "https://www.googleapis.com/auth/gmail.modify",
    LABELS: "https://www.googleapis.com/auth/gmail.labels",
    COMPOSE: "https://www.googleapis.com/auth/gmail.compose",
  },
  CALENDAR: {
    CALENDAR: "https://www.googleapis.com/auth/calendar",
    EVENTS: "https://www.googleapis.com/auth/calendar.events",
  },
} as const;

/**
 * All Google OAuth scopes used by Jazz (Gmail + Calendar)
 */
export const ALL_GOOGLE_SCOPES = [
  GOOGLE_OAUTH_SCOPES.GMAIL.READONLY,
  GOOGLE_OAUTH_SCOPES.GMAIL.SEND,
  GOOGLE_OAUTH_SCOPES.GMAIL.MODIFY,
  GOOGLE_OAUTH_SCOPES.GMAIL.LABELS,
  GOOGLE_OAUTH_SCOPES.GMAIL.COMPOSE,
  GOOGLE_OAUTH_SCOPES.CALENDAR.CALENDAR,
  GOOGLE_OAUTH_SCOPES.CALENDAR.EVENTS,
] as const;

/**
 * Gmail-specific required scopes
 */
export const GMAIL_REQUIRED_SCOPES = [
  GOOGLE_OAUTH_SCOPES.GMAIL.READONLY,
  GOOGLE_OAUTH_SCOPES.GMAIL.SEND,
  GOOGLE_OAUTH_SCOPES.GMAIL.MODIFY,
] as const;

/**
 * Calendar-specific required scopes
 */
export const CALENDAR_REQUIRED_SCOPES = [
  GOOGLE_OAUTH_SCOPES.CALENDAR.CALENDAR,
  GOOGLE_OAUTH_SCOPES.CALENDAR.EVENTS,
] as const;

/**
 * Default OAuth redirect port
 */
export const DEFAULT_GOOGLE_OAUTH_PORT = 53682;

/**
 * Get the OAuth redirect port from environment or use default
 */
export function getGoogleOAuthPort(): number {
  return Number(process.env["GOOGLE_REDIRECT_PORT"] || DEFAULT_GOOGLE_OAUTH_PORT);
}

/**
 * Get the OAuth redirect URI
 */
export function getGoogleOAuthRedirectUri(port?: number): string {
  const oauthPort = port ?? getGoogleOAuthPort();
  return `http://localhost:${oauthPort}/oauth2callback`;
}

/**
 * Get the path to the Google OAuth token file
 * Both Gmail and Calendar services share the same token file
 */
export function getGoogleTokenFilePath(dataDir: string): string {
  return `${dataDir}/google/gmail-token.json`;
}

/**
 * Check if a token has the required scopes
 */
export function hasRequiredScopes(
  token: GoogleOAuthToken,
  requiredScopes: readonly string[],
): boolean {
  const tokenScopes = token.scope?.split(" ") || [];
  return requiredScopes.every((scope) => tokenScopes.includes(scope));
}

/**
 * Check if a token has any of the required scopes (at least one)
 */
export function hasAnyRequiredScope(
  token: GoogleOAuthToken,
  requiredScopes: readonly string[],
): boolean {
  const tokenScopes = token.scope?.split(" ") || [];
  return requiredScopes.some((scope) => tokenScopes.includes(scope));
}
