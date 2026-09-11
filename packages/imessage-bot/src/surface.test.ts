import { renderForIMessage } from "@jazz/bot-shared/imessage-render";
import { bold, code, line, plainLine, subtle, text } from "@jazz/bot-shared/surface";
import { describe, expect, test } from "bun:test";
import { createIMessageSurface } from "./surface";

describe("renderForIMessage", () => {
  test("drops marks it cannot show but keeps code spans readable as quotations", () => {
    expect(
      renderForIMessage({ body: [line(bold("Done"), text(" — "), code("rm -rf build"))] }),
    ).toBe("Done — “rm -rf build”");
  });

  test("renders a cost trailer as an ordinary line, having no way to make it recede", () => {
    expect(renderForIMessage({ body: [subtle(text("Input: 1.2k"))] })).toBe("Input: 1.2k");
  });

  test("numbers a blocking prompt, which the person has to be able to answer", () => {
    const rendered = renderForIMessage({
      body: [plainLine("Approve?")],
      choices: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
      choiceKind: "prompt",
    });
    expect(rendered).toContain("1. Approve");
    expect(rendered).toContain("2. Reject");
    expect(rendered).toContain("reply with a number");
  });

  test("drops suggestions, which would put a menu under every single answer", () => {
    const rendered = renderForIMessage({
      body: [plainLine("Paris is the capital.")],
      choices: [{ id: "deeper", label: "🔍 Go deeper" }],
      choiceKind: "suggestion",
    });
    expect(rendered).toBe("Paris is the capital.");
  });
});

describe("echo guard", () => {
  /** Nothing is sent: only what the surface remembers is under test. */
  const surface = createIMessageSurface({
    binary: "/nonexistent/imsg",
    resolveTarget: () => ({ kind: "chat", chatId: 1 }),
  });

  test("does not claim a message it never sent", () => {
    expect(surface.wasSentByUs("what's the weather?")).toBe(false);
  });

  test("recognises its own text once sent, so it cannot answer itself", async () => {
    // The send fails — the binary does not exist — but the text is recorded
    // before the call, which is what the guard needs: a reply that never left
    // is not one that can come back, and one that did is remembered.
    await surface.send("1", { body: [plainLine("Paris is the capital.")] }).catch(() => undefined);
    expect(surface.wasSentByUs("Paris is the capital.")).toBe(true);
  });

  test("ignores surrounding whitespace, which the transport may not preserve", async () => {
    await surface.send("1", { body: [plainLine("42")] }).catch(() => undefined);
    expect(surface.wasSentByUs("  42 ")).toBe(true);
  });
});
