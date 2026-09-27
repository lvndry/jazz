import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { clearServerAuth, createStoredTokenProvider, hasStoredAuth } from "./oauth";
import metadataDocument from "../../../../oauth-client-metadata.json";

/**
 * The published document and the client's own behaviour have to agree: an
 * authorization server fetches the document and rejects the flow when the
 * request does not match it.
 */
describe("Client ID Metadata Document", () => {
  test("client_id is an https URL with a path, and matches its own location", () => {
    const clientId = metadataDocument.client_id;
    const url = new URL(clientId);

    expect(url.protocol).toBe("https:");
    expect(url.pathname).not.toBe("/");
    // The server validates that the document's client_id equals the URL it
    // fetched, so the filename here must match the constant in oauth.ts.
    expect(clientId.endsWith("/oauth-client-metadata.json")).toBe(true);
  });

  test("declares the required properties", () => {
    expect(metadataDocument.client_id).toBeTruthy();
    expect(metadataDocument.client_name).toBeTruthy();
    expect(Array.isArray(metadataDocument.redirect_uris)).toBe(true);
    expect(metadataDocument.redirect_uris.length).toBeGreaterThan(0);
  });

  test("declares application_type native so OIDC servers accept loopback redirects", () => {
    // Omitting this defaults to "web", which rejects 127.0.0.1 redirect URIs.
    expect(metadataDocument.application_type).toBe("native");
  });

  test("every redirect URI is a fixed loopback callback", () => {
    // Ephemeral ports cannot work under CIMD: the authorization server checks
    // the request's redirect_uri against this exact list.
    for (const uri of metadataDocument.redirect_uris) {
      const url = new URL(uri);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/callback");
      expect(Number(url.port)).toBeGreaterThan(0);
    }
  });

  test("the declared ports match the ones the callback listener tries", async () => {
    const source = await Bun.file("packages/adapters/src/mcp/oauth.ts").text();
    const declared = metadataDocument.redirect_uris.map((uri) => new URL(uri).port).sort();

    const match = source.match(/const CALLBACK_PORTS = \[([^\]]+)\]/);
    const used = (match?.[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .sort();

    // Drift here is invisible until a real authorization fails, so it is
    // pinned rather than left to review.
    expect(used).toEqual(declared);
  });
});

describe("stored MCP OAuth tokens", () => {
  const originalJazzHome = process.env["JAZZ_HOME"];
  const fileBackend = () => Effect.succeed("file" as const);
  let jazzHome: string;

  beforeEach(() => {
    jazzHome = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-mcp-oauth-"));
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(() => {
    if (originalJazzHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = originalJazzHome;
    }
    fs.rmSync(jazzHome, { recursive: true, force: true });
  });

  test("are handed only to the server name and URL they were issued for", async () => {
    const tokens = { access_token: "linear-access", token_type: "Bearer" };
    const issued = createStoredTokenProvider("linear", "https://mcp.linear.app/mcp", fileBackend);
    await issued.saveTokens(tokens);

    const sameServer = createStoredTokenProvider(
      "linear",
      "https://MCP.linear.app/mcp#fragment",
      fileBackend,
    );
    expect(await sameServer.tokens()).toEqual(tokens);

    const shadowingDefinition = createStoredTokenProvider(
      "linear",
      "https://attacker.example/mcp",
      fileBackend,
    );
    expect(await shadowingDefinition.tokens()).toBeUndefined();
    expect(
      await Effect.runPromise(hasStoredAuth("linear", "https://attacker.example/mcp", fileBackend)),
    ).toBe(false);
    expect(
      await Effect.runPromise(hasStoredAuth("linear", "https://mcp.linear.app/mcp", fileBackend)),
    ).toBe(true);
  });

  test("logging out one URL leaves another URL's tokens alone", async () => {
    await createStoredTokenProvider("notes", "https://a.example/mcp", fileBackend).saveTokens({
      access_token: "a",
      token_type: "Bearer",
    });
    await createStoredTokenProvider("notes", "https://b.example/mcp", fileBackend).saveTokens({
      access_token: "b",
      token_type: "Bearer",
    });

    await Effect.runPromise(clearServerAuth("notes", "https://a.example/mcp", fileBackend));

    expect(
      await Effect.runPromise(hasStoredAuth("notes", "https://a.example/mcp", fileBackend)),
    ).toBe(false);
    expect(
      await Effect.runPromise(hasStoredAuth("notes", "https://b.example/mcp", fileBackend)),
    ).toBe(true);
  });
});
