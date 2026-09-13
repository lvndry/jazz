import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { WorkflowRegistryServiceImpl } from "./workflow-registry-service";

/**
 * Fetching, caching, offline fallback, and the origin check are shared with the
 * persona registry and covered in persona-registry-service.test.ts. These tests
 * pin what is specific to workflows: the index fields and the definition check.
 */

const BASE_URL = "https://registry.test/library";

const INDEX = {
  version: 1,
  workflows: [
    {
      name: "weekly-review",
      description: "Review the week's changes",
      schedule: "0 17 * * 5",
      autoApprove: "read-only",
      author: "jazz",
      tags: ["git"],
      url: "/library/workflows/weekly-review.md",
    },
    {
      name: "loose",
      description: "Claims an autonomy tier Jazz does not have",
      autoApprove: "yolo",
      url: "/library/workflows/loose.md",
    },
  ],
};

const WORKFLOW_MD = `---
name: weekly-review
description: Review the week's changes
schedule: "0 17 * * 5"
autoApprove: read-only
maxCostUSD: 1
---

# Weekly review

Inspect commits from the last seven days.
`;

const originalFetch = global.fetch;
let cacheDir: string;

function service(): WorkflowRegistryServiceImpl {
  return new WorkflowRegistryServiceImpl({ baseUrl: BASE_URL, cacheDir });
}

function mockFetch(routes: Record<string, string>): void {
  global.fetch = mock((input: string | URL) => {
    const body = routes[typeof input === "string" ? input : input.toString()];
    return Promise.resolve(
      body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 }),
    );
  }) as unknown as typeof fetch;
}

function routes(workflowMarkdown: string = WORKFLOW_MD): Record<string, string> {
  return {
    [`${BASE_URL}/workflows.json`]: JSON.stringify(INDEX),
    [`${BASE_URL}/workflows/weekly-review.md`]: workflowMarkdown,
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

async function runFailure<A, E>(effect: Effect.Effect<A, E>): Promise<E | null> {
  const exit = await Effect.runPromise(Effect.exit(effect));
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.failureOption(exit.cause));
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "jazz-workflow-registry-test-"));
  delete process.env["JAZZ_OFFLINE"];
});

afterEach(() => {
  global.fetch = originalFetch;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("WorkflowRegistryService", () => {
  it("lists entries with their schedule and autonomy tier, dropping an unknown tier", async () => {
    mockFetch(routes());

    const entries = await run(service().listEntries());

    expect(entries.map((entry) => entry.name)).toEqual(["loose", "weekly-review"]);
    expect(entries[1]?.schedule).toBe("0 17 * * 5");
    expect(entries[1]?.autoApprove).toBe("read-only");
    expect(entries[0]?.autoApprove).toBeUndefined();
  });

  it("downloads the file verbatim and parses its definition with the loader's rules", async () => {
    mockFetch(routes());

    const download = await run(service().fetchWorkflow("weekly-review"));

    expect(download.markdown).toBe(WORKFLOW_MD);
    expect(download.sourceUrl).toBe(`${BASE_URL}/workflows/weekly-review.md`);
    expect(download.definition.maxCostUSD).toBe(1);
    expect(download.definition.autoApprove).toBe("read-only");
    expect(download.prompt).toBe("# Weekly review\n\nInspect commits from the last seven days.");
  });

  it("refuses a definition the workflow loader would not list", async () => {
    mockFetch(routes("---\nname: weekly-review\n---\n\nNo description.\n"));

    const error = await runFailure(service().fetchWorkflow("weekly-review"));

    expect(error?._tag).toBe("ValidationError");
    expect(String((error as { message?: string })?.message)).toContain("name and description");
  });

  it("refuses an empty prompt", async () => {
    mockFetch(routes("---\nname: weekly-review\ndescription: x\n---\n\n"));

    const error = await runFailure(service().fetchWorkflow("weekly-review"));

    expect(String((error as { message?: string })?.message)).toContain("empty prompt");
  });
});
