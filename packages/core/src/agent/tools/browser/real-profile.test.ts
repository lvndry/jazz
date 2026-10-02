/**
 * Tests for `real-profile.ts`: platform-strategy profile discovery, cloning a profile into
 * a launchable snapshot (mirroring the app's wrapped/flat layout), and stripping the
 * singleton locks that would make the launched instance forward to the user's running
 * browser.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { findRealProfileLayout, snapshotRealProfile, stripSingletonLocks } from "./real-profile";

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe("findRealProfileLayout", () => {
  test("returns null for an executable with no recognizable profile", async () => {
    expect(await findRealProfileLayout("/opt/bin/no-such-browser")).toBeNull();
  });

  test("finds a real installed browser where the user has one", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    for (const executable of [
      "/Applications/Dia.app/Contents/MacOS/Dia",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]) {
      const layout = await findRealProfileLayout(executable);
      if (layout === null) {
        continue; // Browser not installed on this machine: not a test failure.
      }
      expect(await exists(path.join(layout.profileDirectory, "Local State"))).toBe(true);
    }
  });
});

describe("snapshotRealProfile", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "jazz-real-profile-test-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("flat layout: clones cookies, drops the caches, returns the user-data root", async () => {
    const source = path.join(root, "source");
    await mkdir(path.join(source, "Default"), { recursive: true });
    await writeFile(path.join(source, "Local State"), "{}", "utf8");
    await writeFile(path.join(source, "Default/Cookies"), "cookie-bytes", "utf8");
    await mkdir(path.join(source, "Default/Code Cache"), { recursive: true });
    await writeFile(path.join(source, "Default/Code Cache/blob"), "cache", "utf8");

    const snapshot = await snapshotRealProfile(source, false, path.join(root, "snap"));
    expect(snapshot).not.toBeNull();
    // The returned directory is the user-data directory; a flat profile sits at its root.
    const cookies = await readFile(
      path.join((snapshot as NonNullable<typeof snapshot>).profileDirectory, "Default/Cookies"),
    );
    expect(cookies.toString()).toBe("cookie-bytes");
    const cacheGone = await exists(
      path.join((snapshot as NonNullable<typeof snapshot>).profileDirectory, "Default/Code Cache"),
    );
    expect(cacheGone).toBe(false);

    await snapshot?.release();
    const gone = await exists((snapshot as NonNullable<typeof snapshot>).profileDirectory);
    expect(gone).toBe(false);
  });

  test("wrapped layout keeps the profile under a User Data folder", async () => {
    const source = path.join(root, "source-wrapped");
    await mkdir(path.join(source, "Default"), { recursive: true });
    await writeFile(path.join(source, "Local State"), "{}", "utf8");
    await writeFile(path.join(source, "Default/Cookies"), "wrapped", "utf8");

    const snapshot = await snapshotRealProfile(source, true, path.join(root, "snap2"));
    expect(snapshot).not.toBeNull();
    const cookies = await readFile(
      path.join(
        (snapshot as NonNullable<typeof snapshot>).profileDirectory,
        "User Data/Default/Cookies",
      ),
    );
    expect(cookies.toString()).toBe("wrapped");

    await snapshot?.release();
  });

  test("resolves null when the source does not exist", async () => {
    const snapshot = await snapshotRealProfile(
      path.join(root, "no-such-source"),
      false,
      path.join(root, "snap3"),
    );
    expect(snapshot).toBeNull();
  });
});

describe("stripSingletonLocks", () => {
  test("removes the triple from both the flat and wrapped locations", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "jazz-singleton-test-"));
    try {
      await mkdir(path.join(profile, "User Data"), { recursive: true });
      for (const file of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
        await writeFile(path.join(profile, file), "x", "utf8");
        await writeFile(path.join(profile, "User Data", file), "x", "utf8");
      }
      await stripSingletonLocks(profile);
      for (const file of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
        expect(await exists(path.join(profile, file))).toBe(false);
        expect(await exists(path.join(profile, "User Data", file))).toBe(false);
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
