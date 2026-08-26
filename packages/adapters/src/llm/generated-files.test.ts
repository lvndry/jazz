import { readFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import {
  artifactKindForMediaType,
  extensionForMediaType,
  saveModelGeneratedFiles,
} from "./generated-files";

describe("artifactKindForMediaType", () => {
  it("maps on the top-level type, so unfamiliar subtypes still work", () => {
    // A model may return any image subtype; rejecting image/avif for not being on a list would
    // lose a file the user can open perfectly well.
    expect(artifactKindForMediaType("image/png")).toBe("image");
    expect(artifactKindForMediaType("image/avif")).toBe("image");
    expect(artifactKindForMediaType("audio/wav")).toBe("audio");
    expect(artifactKindForMediaType("video/mp4")).toBe("video");
  });

  it("recognizes PDF, which has no media top-level type", () => {
    expect(artifactKindForMediaType("application/pdf")).toBe("pdf");
  });

  it("returns null for anything jazz cannot present as a file", () => {
    expect(artifactKindForMediaType("text/plain")).toBeNull();
    expect(artifactKindForMediaType("application/json")).toBeNull();
  });
});

describe("extensionForMediaType", () => {
  it("uses the subtype", () => {
    expect(extensionForMediaType("image/png")).toBe("png");
    expect(extensionForMediaType("audio/wav")).toBe("wav");
  });

  it("prefers the conventional extension over the subtype", () => {
    // "shot.jpeg" and "clip.mpeg" open fine but are not what anyone expects to see.
    expect(extensionForMediaType("image/jpeg")).toBe("jpg");
    expect(extensionForMediaType("audio/mpeg")).toBe("mp3");
  });

  it("strips parameters and vendor suffixes", () => {
    expect(extensionForMediaType("image/svg+xml; charset=utf-8")).toBe("svg");
  });

  it("falls back rather than emitting a nonsense extension", () => {
    expect(extensionForMediaType("application/octet-stream")).toBe("bin");
    expect(extensionForMediaType("garbage")).toBe("bin");
  });
});

describe("saveModelGeneratedFiles", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it("is empty for a text-only response, the common path", async () => {
    expect(await saveModelGeneratedFiles([], "gemini-3-pro-image")).toEqual([]);
  });

  it("writes the bytes and reports where", async () => {
    const artifacts = await saveModelGeneratedFiles(
      [{ mediaType: "image/png", uint8Array: pngBytes }],
      "gemini-3-pro-image",
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path.endsWith(".png")).toBe(true);
    expect(new Uint8Array(await readFile(artifacts[0]!.path))).toEqual(pngBytes);
  });

  it("marks the artifact as model output, not rendered", async () => {
    // The distinction the whole artifact type exists for: these pixels were painted by a model,
    // unlike a chart screenshotted from HTML.
    const [artifact] = await saveModelGeneratedFiles(
      [{ mediaType: "image/png", uint8Array: pngBytes }],
      "gemini-3-pro-image",
    );
    expect(artifact?.source).toBe("model");
    expect(artifact?.tool).toBe("gemini-3-pro-image");
  });

  it("skips media types it cannot present, keeping the rest", async () => {
    const artifacts = await saveModelGeneratedFiles(
      [
        { mediaType: "text/plain", uint8Array: new Uint8Array([1]) },
        { mediaType: "image/png", uint8Array: pngBytes },
      ],
      "some-model",
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe("image");
  });

  it("gives each file its own path", async () => {
    const artifacts = await saveModelGeneratedFiles(
      [
        { mediaType: "image/png", uint8Array: pngBytes },
        { mediaType: "image/png", uint8Array: pngBytes },
      ],
      "some-model",
    );
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.path).not.toBe(artifacts[1]?.path);
  });
});
