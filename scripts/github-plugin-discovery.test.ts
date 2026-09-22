/** Verifies that community discovery validates JSON metadata and never needs plugin source code. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { discoverCommunityPlugins } from "./github-plugin-discovery";

const commit = "a".repeat(40);

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function repository() {
  return {
    id: 123,
    full_name: "example/jazz-plugin",
    html_url: "https://github.com/example/jazz-plugin",
    default_branch: "main",
    description: "A community plugin",
    license: { spdx_id: "MIT" },
    archived: false,
    fork: false,
  };
}

function manifest(entry = "src/index.ts") {
  return {
    schemaVersion: 1,
    id: "com.example.jazz.plugin",
    name: "Example plugin",
    version: "1.0.0",
    hostApi: 1,
    entry,
    hooks: [],
    policyHooks: [],
    decisionProviders: [],
    network: { destinations: [] },
    dataSent: [],
    secrets: [],
  };
}

describe("discoverCommunityPlugins", () => {
  it("indexes a valid manifest at the resolved default-branch commit", async () => {
    const manifestText = JSON.stringify(manifest());
    const fetchImpl = (async (input) => {
      const url = String(input);
      if (url.includes("/search/repositories")) {
        return response({ incomplete_results: false, items: [repository()] });
      }
      if (url.includes("/contents/jazz-plugin.json")) {
        return response({
          type: "file",
          encoding: "base64",
          content: Buffer.from(manifestText).toString("base64"),
        });
      }
      if (url.includes("/commits/")) return response({ sha: commit });
      return response({ error: "not found" }, 404);
    }) as typeof fetch;

    const [entry] = await discoverCommunityPlugins({ fetchImpl });
    expect(entry).toMatchObject({
      sourceType: "community",
      trustTier: "community-indexed",
      repository: "example/jazz-plugin",
      repositoryId: 123,
      defaultBranch: "main",
      sourceSha: commit,
      manifestPath: "jazz-plugin.json",
      manifestUrl: `https://raw.githubusercontent.com/example/jazz-plugin/${commit}/jazz-plugin.json`,
    });
    expect(entry?.manifestSha256).toBe(createHash("sha256").update(manifestText).digest("hex"));
    expect(entry?.entry).toBe("src/index.ts");
  });

  it("skips a repository whose source entry escapes its root", async () => {
    const manifestText = JSON.stringify(manifest("../outside.ts"));
    const fetchImpl = (async (input) => {
      const url = String(input);
      if (url.includes("/search/repositories")) {
        return response({ incomplete_results: false, items: [repository()] });
      }
      if (url.includes("/contents/jazz-plugin.json")) {
        return response({
          type: "file",
          encoding: "base64",
          content: Buffer.from(manifestText).toString("base64"),
        });
      }
      if (url.includes("/commits/")) return response({ sha: commit });
      return response({ error: "not found" }, 404);
    }) as typeof fetch;

    expect(await discoverCommunityPlugins({ fetchImpl })).toEqual([]);
  });

  it("refuses incomplete GitHub search results instead of replacing the snapshot", async () => {
    const fetchImpl = (async () =>
      response({ incomplete_results: true, items: [] })) as unknown as typeof fetch;
    await expect(discoverCommunityPlugins({ fetchImpl })).rejects.toThrow("incomplete");
  });
});
