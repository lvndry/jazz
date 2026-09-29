import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import { EphemeralPanel } from "./EphemeralPanel";
import type { EphemeralRegion } from "./store";

function region(overrides: Partial<EphemeralRegion> = {}): EphemeralRegion {
  return {
    id: "e1",
    kind: "reasoning",
    label: "thinking",
    startedAt: Date.now(),
    tail: ["**bold** plan"],
    maxLines: 6,
    ...overrides,
  };
}

describe("EphemeralPanel", () => {
  test("renders reasoning through the shared markdown parser", () => {
    const output = renderToString(<EphemeralPanel region={region()} />);
    expect(output).not.toContain("**");
    expect(output).toContain("bold");
  });

  test("leaves a subagent panel's raw output untouched, since it can be anything", () => {
    const output = renderToString(
      <EphemeralPanel
        region={region({ kind: "subagent", tail: ['{"result": "**not markdown**"}'] })}
      />,
    );
    expect(output).toContain('{"result": "**not markdown**"}');
  });
});
