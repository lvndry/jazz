/**
 * Checks invitation address discovery without contacting an external service. Overrides must
 * skip discovery, while malformed or oversized lookup replies fail before an invite is stored.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { resolvePeerInviteOrigin } from "./peer-invite-origin";

const unexpectedLookup = (): Promise<Response> => Promise.reject(new Error("unexpected IP lookup"));

describe("peer invite origin", () => {
  it("discovers the public IP with a bounded credential-free HTTPS request", async () => {
    let called = false;
    const origin = await Effect.runPromise(
      resolvePeerInviteOrigin({ port: 4747 }, async (url, options) => {
        called = true;
        expect(url).toBe("https://api.ipify.org");
        expect(options.redirect).toBe("error");
        expect(options.credentials).toBe("omit");
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.headers).toBeUndefined();
        expect(options.body).toBeUndefined();
        return new Response("203.0.113.42\n");
      }),
    );
    expect(called).toBe(true);
    expect(origin).toBe("http://203.0.113.42:4747");
  });

  it.each([
    ["192.0.2.1", "http://192.0.2.1:4747"],
    ["127.0.0.1", "http://127.0.0.1:4747"],
    ["::1", "http://[::1]:4747"],
    ["[2001:db8::1]", "http://[2001:db8::1]:4747"],
    ["peer.example.com", "http://peer.example.com:4747"],
  ])("uses the explicit host without discovery: %s", async (host, expected) => {
    expect(
      await Effect.runPromise(resolvePeerInviteOrigin({ host, port: 4747 }, unexpectedLookup)),
    ).toBe(expected);
  });

  it("lets a public URL override host and port without discovery", async () => {
    expect(
      await Effect.runPromise(
        resolvePeerInviteOrigin(
          { host: "127.0.0.1", port: 4747, publicUrl: "https://peer.example.com:8443/" },
          unexpectedLookup,
        ),
      ),
    ).toBe("https://peer.example.com:8443");
  });

  it.each([
    "ftp://peer.example.com",
    "https://user:secret@peer.example.com",
    "https://peer.example.com/path",
    "https://peer.example.com/?secret=value",
    "not a URL",
  ])("rejects malformed public URLs before discovery: %s", async (publicUrl) => {
    const error = await Effect.runPromise(
      Effect.flip(resolvePeerInviteOrigin({ port: 4747, publicUrl }, unexpectedLookup)),
    );
    expect(error.message).toContain("Could not resolve the invite address");
    expect(error.message).not.toContain("unexpected IP lookup");
  });

  it.each(["not-an-address", "127.0.0.1/path", "203.0.113.1@evil.example", "::1", ""])(
    "rejects an invalid lookup result: %s",
    async (body) => {
      const error = await Effect.runPromise(
        Effect.flip(resolvePeerInviteOrigin({ port: 4747 }, async () => new Response(body))),
      );
      expect(error.message).toContain("invalid IPv4 address");
      expect(error.suggestion).toContain("--host");
    },
  );

  it("rejects an oversized lookup response", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        resolvePeerInviteOrigin({ port: 4747 }, async () => new Response(new Uint8Array(65))),
      ),
    );
    expect(error.message).toContain("too much data");
  });

  it.each([302, 503])("does not use a failed lookup as a host: %s", async (status) => {
    const error = await Effect.runPromise(
      Effect.flip(
        resolvePeerInviteOrigin(
          { port: 4747 },
          async () => new Response("203.0.113.42", { status }),
        ),
      ),
    );
    expect(error.message).toContain("did not return an address");
  });

  it("reports a timeout with an explicit address recovery path", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        resolvePeerInviteOrigin({ port: 4747 }, async () => {
          throw new DOMException("lookup timed out", "TimeoutError");
        }),
      ),
    );
    expect(error.message).toContain("lookup timed out");
    expect(error.suggestion).toContain("--public-url");
  });

  it("rejects invalid ports before discovery", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolvePeerInviteOrigin({ port: 65_536 }, unexpectedLookup)),
    );
    expect(error.message).toContain("between 1 and 65535");
  });
});
