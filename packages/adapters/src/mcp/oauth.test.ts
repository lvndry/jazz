import { describe, expect, test } from "bun:test";
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
