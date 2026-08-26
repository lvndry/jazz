import { describe, expect, it } from "bun:test";
import { buildReplyContext, withReplyContext } from "./quotes";

describe("buildReplyContext", () => {
  it("returns nothing when the message is not a reply", () => {
    expect(buildReplyContext({})).toBeUndefined();
  });

  it("names the bot when the user replies to its own answer", () => {
    const context = buildReplyContext({
      reply_to_message: { text: "Your flight leaves at 6pm.", from: { is_bot: true } },
    });
    expect(context).toBe('[Replying to your earlier message: "Your flight leaves at 6pm."]');
  });

  it("names a human sender, which is what disambiguates a group chat", () => {
    const context = buildReplyContext({
      reply_to_message: { text: "can you book it?", from: { first_name: "Landry" } },
    });
    expect(context).toBe('[Replying to Landry\'s message: "can you book it?"]');
  });

  it("falls back to the username when there is no first name", () => {
    const context = buildReplyContext({
      reply_to_message: { text: "hi", from: { username: "lvndry" } },
    });
    expect(context).toContain("lvndry's message");
  });

  it("stays anonymous when the sender is unknown", () => {
    expect(buildReplyContext({ reply_to_message: { text: "hi" } })).toBe(
      '[Replying to an earlier message: "hi"]',
    );
  });

  it("uses the highlighted fragment when the user quoted part of a message", () => {
    const context = buildReplyContext({
      reply_to_message: { text: "First point. Second point. Third point.", from: { is_bot: true } },
      quote: { text: "Second point." },
    });
    expect(context).toBe('[Replying to your earlier message, quoting: "Second point."]');
  });

  it("describes media that carries no text", () => {
    expect(buildReplyContext({ reply_to_message: { voice: { file_id: "a" } } })).toContain(
      "a voice message",
    );
    expect(buildReplyContext({ reply_to_message: { photo: [{ file_id: "a" }] } })).toContain(
      "a photo",
    );
    expect(
      buildReplyContext({ reply_to_message: { document: { file_name: "notes.pdf" } } }),
    ).toContain("the file notes.pdf");
    expect(buildReplyContext({ reply_to_message: { location: { latitude: 1 } } })).toContain(
      "a location",
    );
  });

  it("keeps both the medium and its caption", () => {
    const context = buildReplyContext({
      reply_to_message: { photo: [{ file_id: "a" }], caption: "the kitchen" },
    });
    expect(context).toBe('[Replying to an earlier message: a photo captioned "the kitchen"]');
  });

  it("ignores an empty photo array rather than claiming a photo", () => {
    expect(buildReplyContext({ reply_to_message: { photo: [] } })).toBeUndefined();
  });

  it("returns nothing when the quoted message has nothing describable", () => {
    expect(buildReplyContext({ reply_to_message: { from: { is_bot: true } } })).toBeUndefined();
  });

  it("collapses newlines so the context stays one line", () => {
    const context = buildReplyContext({ reply_to_message: { text: "line one\n\nline two" } });
    expect(context).toBe('[Replying to an earlier message: "line one line two"]');
  });

  it("truncates a long quote so a reply to a wall of text can't crowd out the prompt", () => {
    const context = buildReplyContext({ reply_to_message: { text: "x".repeat(2_000) } });
    expect(context).toBeDefined();
    expect(context?.length).toBeLessThan(600);
    expect(context).toContain("…");
  });
});

describe("withReplyContext", () => {
  it("leaves a non-reply prompt untouched", () => {
    expect(withReplyContext({}, "what time is it?")).toBe("what time is it?");
  });

  it("puts the context above the user's own text", () => {
    const prompt = withReplyContext(
      { reply_to_message: { text: "6pm", from: { is_bot: true } } },
      "are you sure?",
    );
    expect(prompt).toBe('[Replying to your earlier message: "6pm"]\n\nare you sure?');
  });
});
