import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  compositionIdFromPath,
  compositionLinkPath,
  createCompositionLinks,
  readCompositionImage,
} from "./compositions";
import type { JazzComposition } from "./jazz-run";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "compositions-"));
  mkdirSync(join(dataDir, "compositions", "tg_1-0"), { recursive: true });
  writeFileSync(join(dataDir, "compositions", "tg_1-0", "budget.html"), "<h1>budget</h1>");
  writeFileSync(join(dataDir, "compositions", "tg_1-0", "abc.png"), Buffer.from([0x89, 0x50]));
  writeFileSync(join(dataDir, "secret.html"), "operator secrets");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function composition(overrides: Partial<JazzComposition> = {}): JazzComposition {
  return {
    id: "abc",
    mode: "interactive",
    title: "Budget",
    sessionId: "tg_1-0",
    filename: "budget.html",
    htmlPath: join(dataDir, "compositions", "tg_1-0", "budget.html"),
    ...overrides,
  };
}

describe("published web apps", () => {
  test("are served by an opaque id that survives a new store instance", () => {
    const id = createCompositionLinks(dataDir, "t-compositions.json").publish(
      "tg_1",
      composition(),
    );
    expect(id).toBeDefined();
    const path = compositionLinkPath(id ?? "");
    expect(path).not.toContain("tg_1");
    expect(compositionIdFromPath(path)).toBe(id);

    const reopened = createCompositionLinks(dataDir, "t-compositions.json");
    expect(Buffer.from(reopened.page(id ?? "") ?? []).toString()).toBe("<h1>budget</h1>");
  });

  test("an unknown or malformed id serves nothing", () => {
    const links = createCompositionLinks(dataDir, "t-compositions.json");
    expect(links.page("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(links.page("../secret")).toBeUndefined();
    expect(compositionIdFromPath("/compositions/tg_1-0/budget.html")).toBeUndefined();
  });

  test("names that are not plain segments are never published", () => {
    const links = createCompositionLinks(dataDir, "t-compositions.json");
    expect(links.publish("tg_1", composition({ filename: "../secret.html" }))).toBeUndefined();
    expect(links.publish("tg_1", composition({ sessionId: ".." }))).toBeUndefined();
  });

  test("a session directory swapped for a link serves nothing", () => {
    const links = createCompositionLinks(dataDir, "t-compositions.json");
    const id = links.publish("tg_1", composition({ sessionId: "linked", filename: "secret.html" }));
    symlinkSync(dataDir, join(dataDir, "compositions", "linked"));
    expect(links.page(id ?? "")).toBeUndefined();
  });
});

describe("a static image", () => {
  test("is read from the conversation's own compositions", () => {
    const image = readCompositionImage(
      dataDir,
      composition({
        mode: "static",
        imagePath: join(dataDir, "compositions", "tg_1-0", "abc.png"),
      }),
    );
    expect(image?.filename).toBe("abc.png");
    expect([...(image?.bytes ?? [])]).toEqual([0x89, 0x50]);
  });

  test("named anywhere else is refused", () => {
    for (const imagePath of [join(dataDir, "secret.html"), "/etc/passwd", "/etc/x.png"]) {
      expect(readCompositionImage(dataDir, composition({ mode: "static", imagePath }))).toBe(
        undefined,
      );
    }
  });
});
