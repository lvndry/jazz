import { describe, expect, it } from "bun:test";
import {
  commit,
  composerFromText,
  deleteBackward,
  deleteForward,
  EMPTY_COMPOSER,
  EMPTY_HISTORY,
  hasSelection,
  insertText,
  moveCaret,
  moveCaretVertical,
  redo,
  selectAll,
  selectedText,
  undo,
} from "./composer-edit";

describe("composer-edit", () => {
  it("inserts at the caret and replaces a selection", () => {
    const typed = insertText(EMPTY_COMPOSER, "hello");
    expect(typed).toEqual({ text: "hello", caret: 5, anchor: 5 });

    const mid = moveCaret(typed, 2);
    expect(insertText(mid, "y")).toEqual({ text: "heyllo", caret: 3, anchor: 3 });

    const selected = moveCaret(typed, 1, true);
    expect(selectedText(selected)).toBe("ello");
    expect(insertText(selected, "i")).toEqual({ text: "hi", caret: 2, anchor: 2 });
  });

  it("deletes a selection in either direction, otherwise one character", () => {
    const hello = composerFromText("hello");
    expect(deleteBackward(hello)).toEqual({ text: "hell", caret: 4, anchor: 4 });
    expect(deleteForward(moveCaret(hello, 0))).toEqual({ text: "ello", caret: 0, anchor: 0 });

    const selected = moveCaret(hello, 1, true);
    expect(hasSelection(selected)).toBe(true);
    expect(deleteBackward(selected)).toEqual({ text: "h", caret: 1, anchor: 1 });
    expect(deleteForward(selected)).toEqual({ text: "h", caret: 1, anchor: 1 });
  });

  it("select-all covers the whole buffer", () => {
    const all = selectAll(composerFromText("jazz"));
    expect(selectedText(all)).toBe("jazz");
    expect(all).toEqual({ text: "jazz", caret: 4, anchor: 0 });
  });

  it("undoes text changes and ignores caret-only moves", () => {
    let history = commit(EMPTY_HISTORY, insertText(EMPTY_COMPOSER, "ab"));
    history = commit(history, moveCaret(history.present, 1));
    expect(history.past).toHaveLength(1);
    history = commit(history, insertText(history.present, "X"));
    expect(history.present.text).toBe("aXb");

    history = undo(history);
    expect(history.present.text).toBe("ab");
    history = undo(history);
    expect(history.present).toEqual(EMPTY_COMPOSER);
    history = redo(history);
    expect(history.present.text).toBe("ab");
  });

  it("treats a multi-byte character as one caret step", () => {
    const cafe = insertText(EMPTY_COMPOSER, "café");
    expect(cafe.caret).toBe(4);
    expect(deleteBackward(cafe).text).toBe("caf");
  });

  describe("moveCaretVertical", () => {
    const spread = (text: string) => [...text];

    it("moves down to the same column on the next line", () => {
      const text = "hello\nworld";
      expect(moveCaretVertical(spread(text), 2, 1)).toBe(8);
    });

    it("moves up to the same column on the previous line", () => {
      const text = "hello\nworld";
      expect(moveCaretVertical(spread(text), 8, -1)).toBe(2);
    });

    it("clamps to a shorter line when moving down", () => {
      const text = "long line\nhi";
      expect(moveCaretVertical(spread(text), 7, 1)).toBe(12);
    });

    it("clamps to a shorter line when moving up", () => {
      const text = "hi\nlong line";
      expect(moveCaretVertical(spread(text), 10, -1)).toBe(2);
    });

    it("moves to position 0 when pressing up on the first line", () => {
      const text = "hello\nworld";
      expect(moveCaretVertical(spread(text), 3, -1)).toBe(0);
    });

    it("moves to the end when pressing down on the last line", () => {
      const text = "hello\nworld";
      expect(moveCaretVertical(spread(text), 8, 1)).toBe(11);
    });

    it("handles three lines", () => {
      const text = "aaa\nbbb\nccc";
      expect(moveCaretVertical(spread(text), 5, 1)).toBe(9);
      expect(moveCaretVertical(spread(text), 9, -1)).toBe(5);
    });

    it("handles single-line text", () => {
      const text = "hello";
      expect(moveCaretVertical(spread(text), 3, -1)).toBe(0);
      expect(moveCaretVertical(spread(text), 3, 1)).toBe(5);
    });

    it("handles empty lines", () => {
      const text = "hello\n\nworld";
      expect(moveCaretVertical(spread(text), 3, 1)).toBe(6);
      expect(moveCaretVertical(spread(text), 6, 1)).toBe(6 + 1);
      expect(moveCaretVertical(spread(text), 6, -1)).toBe(0 + 0);
    });
  });
});
