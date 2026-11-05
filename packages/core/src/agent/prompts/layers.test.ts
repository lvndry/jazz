import { describe, expect, test } from "bun:test";
import {
  renderPromptLayers,
  renderPromptLayersWithStablePrefix,
  type PromptLayers,
} from "./layers";

describe("renderPromptLayers", () => {
  test("renders Core, Scope, and Live in precedence order", () => {
    const layers: PromptLayers = {
      core: [
        { id: "persona", content: "Persona" },
        { id: "harness", content: "Harness" },
      ],
      scope: [{ id: "project", content: "Project" }],
      live: [{ id: "environment", content: "Environment" }],
    };

    expect(renderPromptLayers(layers)).toBe("Persona\n\nHarness\n\nProject\n\nEnvironment");
  });

  test("omits empty sections without disturbing layer order", () => {
    const layers: PromptLayers = {
      core: [{ id: "persona", content: " Persona " }],
      scope: [{ id: "empty", content: "  " }],
      live: [],
    };

    expect(renderPromptLayers(layers)).toBe("Persona");
  });
});

describe("renderPromptLayersWithStablePrefix", () => {
  const layers: PromptLayers = {
    core: [
      { id: "persona", content: "Persona", stable: true },
      { id: "harness", content: "Harness", stable: true },
      { id: "indexes", content: "Indexes" },
    ],
    scope: [{ id: "project", content: "Project" }],
    live: [{ id: "environment", content: "Environment" }],
  };

  test("renders the same text as renderPromptLayers", () => {
    expect(renderPromptLayersWithStablePrefix(layers).text).toBe(renderPromptLayers(layers));
  });

  test("the stable prefix and the remainder concatenate back to the text", () => {
    const { text, stablePrefixLength } = renderPromptLayersWithStablePrefix(layers);

    expect(stablePrefixLength).toBeDefined();
    expect(text.slice(0, stablePrefixLength)).toBe("Persona\n\nHarness");
    expect(text.slice(stablePrefixLength)).toBe("\n\nIndexes\n\nProject\n\nEnvironment");
  });

  test("a stable section after a volatile one does not extend the prefix", () => {
    const { text, stablePrefixLength } = renderPromptLayersWithStablePrefix({
      core: [
        { id: "persona", content: "Persona", stable: true },
        { id: "volatile", content: "Volatile" },
        { id: "late", content: "Late", stable: true },
      ],
      scope: [],
      live: [],
    });

    expect(text.slice(0, stablePrefixLength)).toBe("Persona");
  });

  test("reports no prefix when nothing leads stable or nothing follows it", () => {
    const volatileFirst = renderPromptLayersWithStablePrefix({
      core: [{ id: "persona", content: "Persona" }],
      scope: [],
      live: [],
    });
    const allStable = renderPromptLayersWithStablePrefix({
      core: [{ id: "persona", content: "Persona", stable: true }],
      scope: [],
      live: [],
    });

    expect(volatileFirst.stablePrefixLength).toBeUndefined();
    expect(allStable.stablePrefixLength).toBeUndefined();
  });

  test("an empty stable section does not shift the prefix", () => {
    const { text, stablePrefixLength } = renderPromptLayersWithStablePrefix({
      core: [
        { id: "empty", content: "  ", stable: true },
        { id: "persona", content: "Persona", stable: true },
      ],
      scope: [],
      live: [{ id: "environment", content: "Environment" }],
    });

    expect(text.slice(0, stablePrefixLength)).toBe("Persona");
  });
});
