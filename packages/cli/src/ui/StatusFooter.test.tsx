import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import StatusFooter from "./StatusFooter";

describe("StatusFooter", () => {
  test("offers the mode switch on a fresh session with no stats", () => {
    const output = renderToString(
      <StatusFooter
        status={null}
        workingDirectory={null}
        runStats={{}}
      />,
    );
    expect(output).toContain("shift+tab for yolo");
  });

  test("separates the yolo label from the switch hint when there are no stats", () => {
    const output = renderToString(
      <StatusFooter
        status={null}
        workingDirectory={null}
        runStats={{}}
        modeIsYolo
        background="watching 2"
      />,
    );
    expect(output).toContain("yolo · shift+tab for safe · watching 2");
  });
});
