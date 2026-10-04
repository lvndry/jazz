/**
 * composition-og: the OG card renders a real PNG (or an empty buffer when the
 * font stack is unavailable — the card is an enhancement, never a blocker),
 * and the HTML helpers behave (title extraction, idempotent meta injection).
 */
import { describe, expect, test } from "bun:test";
import { injectOgMeta, renderCompositionOg, titleFromHtml } from "./composition-og";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("renderCompositionOg", () => {
  test("returns PNG bytes for a real title", () => {
    const png = renderCompositionOg("Weekly Spending");
    if (png.length === 0) {
      // Fonts unavailable in this environment — the enhancement degrades to
      // "no card" and the publish proceeds without one.
      return;
    }
    expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    // A 1200x630 card is never trivially small.
    expect(png.length).toBeGreaterThan(4000);
  });

  test("is deterministic for the same title", () => {
    const a = renderCompositionOg("Determinism Check");
    const b = renderCompositionOg("Determinism Check");
    expect(a.equals(b)).toBe(true);
  });

  test("wraps long titles without throwing", () => {
    const png = renderCompositionOg(
      "A Very Long Composition Title That Should Wrap Across Multiple Lines Nicely",
    );
    expect(png.length).toBeGreaterThanOrEqual(0);
  });
});

describe("titleFromHtml", () => {
  test("extracts the title and strips a trailing subtitle", () => {
    expect(
      titleFromHtml(
        "<html><head><title>The Hidden War — the Bamiléké Genocide, 1958–1964</title></head></html>",
      ),
    ).toBe("The Hidden War");
  });

  test("keeps a plain title", () => {
    expect(titleFromHtml("<title>Weekly Spending</title>")).toBe("Weekly Spending");
  });

  test("falls back when there is no title", () => {
    expect(titleFromHtml("<html><body>x</body></html>")).toBe("Untitled composition");
  });
});

describe("injectOgMeta", () => {
  const html = "<html><head><title>Weekly Spending</title></head><body>x</body></html>";
  const url = "https://lvndry.pages.dev/compositions/weekly-spending/og.png";

  test("adds og tags after <head>", () => {
    const out = injectOgMeta(html, "Weekly Spending", url);
    expect(out).toContain(
      '<meta property="og:image" content="https://lvndry.pages.dev/compositions/weekly-spending/og.png">',
    );
    expect(out).toContain('property="og:title"');
    expect(out).toContain('name="twitter:card"');
  });

  test("is idempotent — a second run replaces the block in place", () => {
    const once = injectOgMeta(html, "Weekly Spending", url);
    const twice = injectOgMeta(once, "Weekly Spending", url);
    expect(twice).toBe(once);
    expect(twice.match(/jazz:og/g)?.length).toBe(2); // one marker pair, no duplicates
  });

  test("replaces the image URL when re-run with a new one", () => {
    const once = injectOgMeta(html, "Weekly Spending", url);
    const other = injectOgMeta(once, "Weekly Spending", url.replace("weekly-spending", "other"));
    expect(other).not.toBe(once);
    expect(other).toContain('content="https://lvndry.pages.dev/compositions/other/og.png"');
    expect(other).not.toContain("compositions/weekly-spending/og.png");
  });

  test("escapes XML entities in the title", () => {
    const out = injectOgMeta(html, 'A <b> "quoted" </b> title', url);
    expect(out).toContain("A &lt;b&gt; &quot;quoted&quot; &lt;/b&gt; title");
    expect(out).not.toContain("A <b>");
  });

  test("returns the HTML unchanged when there is no <head>", () => {
    const body = "<body>no head here</body>";
    expect(injectOgMeta(body, "T", url)).toBe(body);
  });
});
