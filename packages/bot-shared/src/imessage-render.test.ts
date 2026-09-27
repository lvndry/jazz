/** Shared-core merge regression: iMessage converts Markdown while preserving literal code. */
import { expect, test } from "bun:test";
import { renderForIMessage } from "./imessage-render";
import { codeBlock, markdown } from "./surface";

test("renders Markdown as plain text without stripping literal code", () => {
  expect(renderForIMessage({ body: [markdown("**hello**"), codeBlock("**literal**")] })).toBe(
    "hello\n**literal**",
  );
});
