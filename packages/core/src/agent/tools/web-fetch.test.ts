import { describe, expect, test } from "bun:test";
import { isSupportedContentType } from "./web-fetch";

describe("isSupportedContentType", () => {
  test("accepts every text/* subtype, with or without parameters", () => {
    expect(isSupportedContentType("text/html")).toBe(true);
    expect(isSupportedContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isSupportedContentType("text/markdown; charset=utf-8")).toBe(true);
    expect(isSupportedContentType("text/x-markdown")).toBe(true);
    expect(isSupportedContentType("text/csv")).toBe(true);
  });

  test("accepts the common textual application types", () => {
    expect(isSupportedContentType("application/json")).toBe(true);
    expect(isSupportedContentType("application/xml")).toBe(true);
    expect(isSupportedContentType("application/markdown")).toBe(true);
    expect(isSupportedContentType("application/yaml")).toBe(true);
  });

  test("accepts structured-syntax suffixes (RFC 6839)", () => {
    expect(isSupportedContentType("application/ld+json")).toBe(true);
    expect(isSupportedContentType("application/rss+xml")).toBe(true);
    expect(isSupportedContentType("application/vnd.api+json")).toBe(true);
  });

  test("is case-insensitive and ignores surrounding whitespace", () => {
    expect(isSupportedContentType("Text/HTML")).toBe(true);
    expect(isSupportedContentType("  application/JSON ; charset=utf-8")).toBe(true);
  });

  test("rejects binary types", () => {
    expect(isSupportedContentType("application/pdf")).toBe(false);
    expect(isSupportedContentType("image/png")).toBe(false);
    expect(isSupportedContentType("image/svg+xml")).toBe(false);
    expect(isSupportedContentType("application/octet-stream")).toBe(false);
    expect(isSupportedContentType("application/zip")).toBe(false);
    expect(isSupportedContentType("")).toBe(false);
  });
});
