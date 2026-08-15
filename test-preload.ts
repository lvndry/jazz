/**
 * Bun test preload — runs before every test file.
 *
 * Pin the glyph mode so rendering assertions are deterministic regardless of
 * the host environment: CI runners export a UTF-8 locale (which the runtime
 * detection maps to unicode glyphs) while local shells may not. Tests that
 * exercise the detection itself (glyphs.test.ts) manage the env var
 * explicitly per-test, so this default doesn't constrain them.
 */
process.env["JAZZ_UI_GLYPHS"] ??= "ascii";

/**
 * Default tests to offline mode so the models.dev catalog loader never fetches the
 * real catalog (or mirrors it into the developer's ~/.jazz) from inside the
 * suite. Tests that exercise the fetch/cache behavior itself
 * (models-dev.test.ts) manage this env var explicitly per-test.
 */
process.env["JAZZ_OFFLINE"] ??= "1";
