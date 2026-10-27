/**
 * Runs the release's registry wait against a fake `curl`, so no registry is contacted. The fake
 * answers from a per-package count of polls, standing in for a version the registry starts
 * serving some polls after its publish.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const script = path.join(import.meta.dir, "wait-for-npm-packages.sh");
const directories: string[] = [];

/** Fake curl: serves `version` for a package once it has been polled `servedAfter` times. */
function fakeRegistry(servedAfter: Readonly<Record<string, number>>, version: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "jazz-wait-npm-"));
  directories.push(directory);
  const curl = path.join(directory, "curl");
  writeFileSync(
    curl,
    `#!/bin/sh
echo "$*" >> "${directory}/calls"
for arg in "$@"; do url="$arg"; done
name="\${url##*/}"
count=$(( $(cat "${directory}/$name.polls" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "${directory}/$name.polls"
case "$name" in
${Object.entries(servedAfter)
  .map(([name, polls]) => `  ${name}) needed=${String(polls)};;`)
  .join("\n")}
  *) needed=999999;;
esac
if [ "$count" -ge "$needed" ]; then
  printf '{"versions":{"%s":{}}}' "${version}"
else
  printf '{"versions":{}}'
fi
`,
  );
  chmodSync(curl, 0o755);
  return directory;
}

function wait(directory: string, packages: readonly string[], waitSeconds = 30) {
  return spawnSync("sh", [script, ...packages], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
      POLL_SECONDS: "0",
      WAIT_SECONDS: String(waitSeconds),
    },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("wait-for-npm-packages", () => {
  test("returns once every package is served, polling the late ones until they are", () => {
    const directory = fakeRegistry({ "jazz-ai-darwin-arm64": 1, "jazz-ai-linux-x64": 4 }, "1.2.3");

    const result = wait(directory, ["jazz-ai-darwin-arm64@1.2.3", "jazz-ai-linux-x64@1.2.3"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("jazz-ai-linux-x64@1.2.3 is served");
    expect(readFileSync(path.join(directory, "jazz-ai-linux-x64.polls"), "utf8").trim()).toBe("4");
  });

  test("fails without waiting forever when a package is never served", () => {
    const directory = fakeRegistry({ "jazz-ai-linux-x64": 1 }, "1.2.3");

    const result = wait(directory, ["jazz-ai-linux-x64@1.2.3", "jazz-ai-linux-x64-musl@1.2.3"], 1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("jazz-ai-linux-x64-musl@1.2.3 is still not served");
  });

  test("does not count an older version as served", () => {
    const directory = fakeRegistry({ "jazz-ai-linux-x64": 1 }, "1.2.2");

    expect(wait(directory, ["jazz-ai-linux-x64@1.2.3"], 1).status).toBe(1);
  });

  test("bounds every request, so a stalled registry cannot outlast the deadline", () => {
    const directory = fakeRegistry({ "jazz-ai-linux-x64": 1 }, "1.2.3");

    wait(directory, ["jazz-ai-linux-x64@1.2.3"]);

    const call = readFileSync(path.join(directory, "calls"), "utf8");
    expect(call).toMatch(/--connect-timeout \d+/);
    expect(call).toMatch(/--max-time \d+/);
    expect(call).toContain("application/vnd.npm.install-v1+json");
  });
});
