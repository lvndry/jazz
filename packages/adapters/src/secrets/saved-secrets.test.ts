import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createSavedSecretsService, savedSecretAccount } from "./saved-secrets";

const SECRET = "cf-token-0123456789abcdef";

describe("saved secrets over the file backend", () => {
  const originalJazzHome = process.env["JAZZ_HOME"];
  let home = "";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-saved-secrets-test-"));
    process.env["JAZZ_HOME"] = home;
  });

  afterEach(() => {
    if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = originalJazzHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const service = () => createSavedSecretsService(() => Effect.succeed("file"));

  it("keeps the value in the secret store and only the name in the index", async () => {
    const saved = service();
    expect(
      await Effect.runPromise(saved.save("cloudflare-token", SECRET, "Cloudflare API token")),
    ).toBe(true);

    const index = fs.readFileSync(path.join(home, "saved-secrets.json"), "utf-8");
    expect(index).toContain("cloudflare-token");
    expect(index).not.toContain(SECRET);
    const store = JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf-8")) as Record<
      string,
      string
    >;
    expect(store[savedSecretAccount("cloudflare-token")]).toBe(SECRET);

    const listed = await Effect.runPromise(saved.list);
    expect(listed.map((entry) => [entry.name, entry.description])).toEqual([
      ["cloudflare-token", "Cloudflare API token"],
    ]);
    expect(await Effect.runPromise(saved.read("cloudflare-token"))).toBe(SECRET);
  });

  it("is shared by every service on the same home, as each run makes its own", async () => {
    await Effect.runPromise(service().save("cloudflare-token", SECRET, ""));
    expect(await Effect.runPromise(service().read("cloudflare-token"))).toBe(SECRET);
  });

  it("replaces a value saved again under the same name", async () => {
    const saved = service();
    await Effect.runPromise(saved.save("cloudflare-token", "old-value", "old"));
    await Effect.runPromise(saved.save("cloudflare-token", SECRET, "new"));
    expect(await Effect.runPromise(saved.read("cloudflare-token"))).toBe(SECRET);
    expect((await Effect.runPromise(saved.list)).map((entry) => entry.description)).toEqual([
      "new",
    ]);
  });

  it("forgets the value and the name together", async () => {
    const saved = service();
    await Effect.runPromise(saved.save("cloudflare-token", SECRET, ""));
    expect(await Effect.runPromise(saved.remove("cloudflare-token"))).toBe(true);
    expect(await Effect.runPromise(saved.read("cloudflare-token"))).toBeUndefined();
    expect(await Effect.runPromise(saved.list)).toEqual([]);
    expect(await Effect.runPromise(saved.remove("cloudflare-token"))).toBe(false);
  });

  it("reads nothing for a name the index does not list", async () => {
    expect(await Effect.runPromise(service().read("cloudflare-token"))).toBeUndefined();
  });
});
