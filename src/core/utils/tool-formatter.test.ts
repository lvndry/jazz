import { describe, expect, test } from "bun:test";
import { formatToolArguments } from "./tool-formatter";

describe("formatToolArguments http_request", () => {
  test("merges query params into the displayed URL", () => {
    const formatted = formatToolArguments(
      "http_request",
      {
        method: "GET",
        url: "https://duckduckgo.com/html/",
        query: { q: "Ye latest concert 2025" },
      },
      { style: "plain" },
    );
    expect(formatted).toContain("https://duckduckgo.com/html/?q=Ye%20latest%20concert%202025");
  });

  test("appends with & when the URL already has a query string", () => {
    const formatted = formatToolArguments(
      "http_request",
      {
        method: "GET",
        url: "https://example.com/search?page=2",
        query: { q: "tickets" },
      },
      { style: "plain" },
    );
    expect(formatted).toContain("https://example.com/search?page=2&q=tickets");
  });

  test("leaves the URL untouched without query params", () => {
    const formatted = formatToolArguments(
      "http_request",
      { method: "GET", url: "https://example.com/" },
      { style: "plain" },
    );
    expect(formatted).toContain("url: https://example.com/");
    expect(formatted).not.toContain("?");
  });
});
