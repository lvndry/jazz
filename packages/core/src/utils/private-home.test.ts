import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { PERMISSION_REPAIR_MARKER, securePrivateHome } from "./private-home";

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o7777;
}

describe("securePrivateHome", () => {
  test("creates a missing home owner-only", async () => {
    const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-home-")), "home");
    securePrivateHome(home);
    expect(modeOf(home)).toBe(0o700);
  });

  test("repairs a world-readable home once, keeping owner execute bits", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-home-"));
    fs.chmodSync(home, 0o755);
    fs.mkdirSync(path.join(home, "history", "conversations"), { recursive: true, mode: 0o755 });
    const log = path.join(home, "history", "conversations", "c1.jsonl");
    fs.writeFileSync(log, "{}");
    fs.chmodSync(log, 0o644);
    const script = path.join(home, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh");
    fs.chmodSync(script, 0o755);

    const first = securePrivateHome(home);

    expect(first).toEqual({ repaired: true, failures: 0 });
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(path.join(home, "history"))).toBe(0o700);
    expect(modeOf(log)).toBe(0o600);
    expect(modeOf(script)).toBe(0o700);
    expect(fs.existsSync(path.join(home, PERMISSION_REPAIR_MARKER))).toBe(true);

    fs.chmodSync(log, 0o644);
    const second = securePrivateHome(home);
    expect(second.repaired).toBe(false);
    expect(modeOf(log)).toBe(0o644);
  });

  test("leaves a symbolic link's target alone", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-home-"));
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-outside-")), "shared");
    fs.writeFileSync(outside, "", { mode: 0o644 });
    fs.symlinkSync(outside, path.join(home, "personas"));
    securePrivateHome(home);
    expect(modeOf(outside)).toBe(0o644);
  });

  test("keeps group read in a group-shared (setgid) home", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-home-"));
    fs.chmodSync(home, 0o2775);
    if ((fs.statSync(home).mode & 0o2000) === 0) {
      return;
    }
    const file = path.join(home, "state.json");
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, 0o664);
    securePrivateHome(home);
    expect(modeOf(file)).toBe(0o660);
    expect(modeOf(home)).toBe(0o2770);
  });
});
