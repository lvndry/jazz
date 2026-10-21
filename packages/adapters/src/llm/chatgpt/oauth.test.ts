import { describe, expect, it } from "bun:test";
import { ChatGPTTokenRejectedError, readAccessTokenClaims } from "./oauth";

function accessToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
}

describe("readAccessTokenClaims", () => {
  it("reads the ChatGPT account and plan", () => {
    const token = accessToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1", chatgpt_plan_type: "plus" },
    });
    expect(readAccessTokenClaims(token)).toEqual({ accountId: "account-1", plan: "plus" });
  });

  it("decodes base64url payloads whose bytes need '-' or '_'", () => {
    // "~~~" encodes to "fn5-" in base64url, which plain base64 decoding would mangle.
    const token = accessToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc~~~" },
    });
    expect(readAccessTokenClaims(token).accountId).toBe("acc~~~");
  });

  it("returns nothing for a login without a ChatGPT account or a malformed token", () => {
    expect(readAccessTokenClaims(accessToken({ sub: "user" }))).toEqual({});
    expect(readAccessTokenClaims("not-a-jwt")).toEqual({});
  });
});

describe("ChatGPTTokenRejectedError", () => {
  it("reduces OpenAI's JSON error to its code and message", () => {
    const body = JSON.stringify({
      error: {
        message: "Invalid refresh token.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_refresh_token",
      },
    });
    expect(new ChatGPTTokenRejectedError("refresh", 401, body).message).toBe(
      "ChatGPT token refresh failed (401): invalid_refresh_token: Invalid refresh token.",
    );
  });

  it("reads OAuth's error and error_description", () => {
    const body = JSON.stringify({ error: "invalid_grant", error_description: "Token revoked" });
    expect(new ChatGPTTokenRejectedError("refresh", 400, body).message).toBe(
      "ChatGPT token refresh failed (400): invalid_grant: Token revoked",
    );
  });

  it("strips control characters and bounds a raw body", () => {
    const message = new ChatGPTTokenRejectedError(
      "refresh",
      502,
      `\u001b]0;pwned\u0007${"x".repeat(500)}`,
    ).message;
    expect([...message].some((character) => character.charCodeAt(0) < 0x20)).toBe(false);
    expect(message.length).toBeLessThan(260);
  });
});
