import { describe, expect, it } from "bun:test";
import { readAccessTokenClaims } from "./oauth";

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
