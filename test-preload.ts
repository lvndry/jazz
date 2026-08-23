import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

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

/**
 * Keep the suite away from the developer's real OS keyring. Without this, any
 * test that builds a config layer would probe — and, worse, migrate real
 * plaintext keys into — the login keychain. Tests covering keyring behavior set
 * this to "0" explicitly.
 */
process.env["JAZZ_DISABLE_KEYRING"] ??= "1";

/**
 * Point the suite at a throwaway Jazz home.
 *
 * Every storage helper falls back to `~/.jazz` when a caller passes no directory, so one
 * test with a missing `dir` argument writes into the developer's real history, agents or
 * memory — silently, and only noticed later when something unexplained shows up there.
 * A stray conversation log written this way is what prompted this.
 *
 * `??=` so a test that exercises home-directory resolution can still set its own.
 */
process.env["JAZZ_HOME"] ??= mkdtempSync(path.join(tmpdir(), "jazz-test-home-"));
