import { describe, expect, test } from "bun:test";
import {
  type AccessibilityNode,
  buildSnapshot,
  SNAPSHOT_CHARACTER_CAP,
  snapshotWindow,
} from "./snapshot";

function node(
  nodeId: string,
  role: string,
  fields: Partial<AccessibilityNode> & { name?: string } = {},
): AccessibilityNode {
  const { name, ...rest } = fields;
  return {
    nodeId,
    role: { value: role },
    ...(name === undefined ? {} : { name: { value: name } }),
    ...rest,
  };
}

function tree(...nodes: AccessibilityNode[]): readonly AccessibilityNode[] {
  return nodes;
}

describe("buildSnapshot", () => {
  test("prints headings, links and fields with refs on interactive elements only", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Sign in", childIds: ["2", "3", "4", "5"] }),
        node("2", "heading", {
          name: "Welcome",
          parentId: "1",
          properties: [{ name: "level", value: { value: 1 } }],
        }),
        node("3", "textbox", {
          name: "Email",
          parentId: "1",
          backendDOMNodeId: 30,
          value: { value: "me@example.com" },
        }),
        node("4", "button", { name: "Continue", parentId: "1", backendDOMNodeId: 40 }),
        node("5", "link", {
          name: "Forgot password",
          parentId: "1",
          backendDOMNodeId: 50,
          properties: [{ name: "url", value: { value: "https://example.com/reset" } }],
        }),
      ),
    );

    expect(snapshot.text).toBe(
      [
        '- page "Sign in"',
        '  - heading "Welcome" [level=1]',
        '  - textbox "Email" = "me@example.com" [ref=e1]',
        '  - button "Continue" [ref=e2]',
        '  - link "Forgot password" -> https://example.com/reset [ref=e3]',
      ].join("\n"),
    );
    expect([...snapshot.refs.entries()]).toEqual([
      ["e1", { backendNodeId: 30, label: 'textbox "Email"' }],
      ["e2", { backendNodeId: 40, label: 'button "Continue"' }],
      ["e3", { backendNodeId: 50, label: 'link "Forgot password"' }],
    ]);
    expect(snapshot.truncated).toBe(false);
  });

  test("drops ignored nodes and unnamed generic wrappers but keeps their children", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Page", childIds: ["2"] }),
        node("2", "generic", { parentId: "1", childIds: ["3"] }),
        node("3", "none", { parentId: "2", ignored: true, childIds: ["4"] }),
        node("4", "button", { name: "Go", parentId: "3", backendDOMNodeId: 4 }),
      ),
    );

    expect(snapshot.text).toBe(['- page "Page"', '  - button "Go" [ref=e1]'].join("\n"));
  });

  test("omits static text that an ancestor's name already repeats", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Page", childIds: ["2", "4"] }),
        node("2", "link", {
          name: "Read the docs",
          parentId: "1",
          backendDOMNodeId: 2,
          childIds: ["3"],
        }),
        node("3", "StaticText", { name: "Read the docs", parentId: "2" }),
        node("4", "StaticText", { name: "Plain paragraph", parentId: "1" }),
      ),
    );

    expect(snapshot.text).toBe(
      ['- page "Page"', '  - link "Read the docs" [ref=e1]', '  text "Plain paragraph"'].join("\n"),
    );
  });

  test("does not let the page title hide text that happens to share its letters", () => {
    const letters = [..."This domain is for use in documentation."];
    const characterNodes = letters.map((letter, index) =>
      node(String(index + 3), "StaticText", { name: letter, parentId: "2" }),
    );
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Example Domain", childIds: ["2"] }),
        node("2", "paragraph", {
          name: "",
          parentId: "1",
          childIds: characterNodes.map((child) => child.nodeId),
        }),
        ...characterNodes,
      ),
    );

    expect(snapshot.text).toBe(
      ['- page "Example Domain"', '  text "This domain is for use in documentation."'].join("\n"),
    );
  });

  test("merges adjacent text nodes into one line, keeping the spaces between words", () => {
    const words = ["Hello", " ", "big", " ", "world"].map((word, index) =>
      node(String(index + 2), "StaticText", { name: word, parentId: "1" }),
    );
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Page", childIds: words.map((word) => word.nodeId) }),
        ...words,
      ),
    );

    expect(snapshot.text).toBe(['- page "Page"', '  text "Hello big world"'].join("\n"));
  });

  test("merges text that a page wraps in one element per character", () => {
    const letters = [..."Read me"];
    const wrappers = letters.map((_, index) =>
      node(String(index + 10), "generic", {
        parentId: "1",
        childIds: [String(index + 100)],
      }),
    );
    const characterNodes = letters.map((letter, index) =>
      node(String(index + 100), "StaticText", { name: letter, parentId: String(index + 10) }),
    );
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", {
          name: "Page",
          childIds: wrappers.map((wrapper) => wrapper.nodeId),
        }),
        ...wrappers,
        ...characterNodes,
      ),
    );

    expect(snapshot.text).toBe(['- page "Page"', '  text "Read me"'].join("\n"));
  });

  test("treats a presentational node as transparent even when a browser names it", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Form", childIds: ["2"] }),
        node("2", "none", { name: "Name", parentId: "1", childIds: ["3"] }),
        node("3", "textbox", { name: "Name", parentId: "2", backendDOMNodeId: 3 }),
      ),
    );

    expect(snapshot.text).toBe(['- page "Form"', '  - textbox "Name" [ref=e1]'].join("\n"));
  });

  test("prints the text before and after a control as separate lines", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Page", childIds: ["2", "3", "4"] }),
        node("2", "StaticText", { name: "Before", parentId: "1" }),
        node("3", "button", { name: "Go", parentId: "1", backendDOMNodeId: 3 }),
        node("4", "StaticText", { name: "After", parentId: "1" }),
      ),
    );

    expect(snapshot.text).toBe(
      ['- page "Page"', '  text "Before"', '  - button "Go" [ref=e1]', '  text "After"'].join("\n"),
    );
  });

  test("keeps a long paragraph whole instead of cutting it at the name length", () => {
    const sentence = "A full sentence of ordinary body text that a reader needs in full. ";
    const body = sentence.repeat(10).trim();
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Page", childIds: ["2"] }),
        node("2", "StaticText", { name: body, parentId: "1" }),
      ),
    );

    expect(snapshot.text).toContain(body);
    expect(snapshot.text).not.toContain("…");
  });

  test("flattens unnamed paragraphs, label wrappers and select popups", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Form", childIds: ["2", "5"] }),
        node("2", "LabelText", { name: "", parentId: "1", childIds: ["3", "4"] }),
        node("3", "StaticText", { name: "Size", parentId: "2" }),
        node("4", "combobox", {
          name: "Size",
          parentId: "2",
          backendDOMNodeId: 4,
          childIds: ["6"],
        }),
        node("5", "paragraph", { name: "", parentId: "1", childIds: ["7"] }),
        node("6", "MenuListPopup", { name: "", parentId: "4", childIds: ["8"] }),
        node("7", "StaticText", { name: "Done", parentId: "5" }),
        node("8", "option", { name: "Large", parentId: "6", backendDOMNodeId: 8 }),
      ),
    );

    expect(snapshot.text).toBe(
      [
        '- page "Form"',
        '  text "Size"',
        '  - combobox "Size" [ref=e1]',
        '    - option "Large" [ref=e2]',
        '  text "Done"',
      ].join("\n"),
    );
  });

  test("prints state properties and hides false booleans", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Form", childIds: ["2", "3"] }),
        node("2", "checkbox", {
          name: "Remember me",
          parentId: "1",
          backendDOMNodeId: 2,
          properties: [
            { name: "checked", value: { value: "true" } },
            { name: "disabled", value: { value: false } },
            { name: "required", value: { value: true } },
          ],
        }),
        node("3", "tab", {
          name: "Billing",
          parentId: "1",
          backendDOMNodeId: 3,
          properties: [{ name: "selected", value: { value: true } }],
        }),
      ),
    );

    expect(snapshot.text).toContain('- checkbox "Remember me" [checked=true, required] [ref=e1]');
    expect(snapshot.text).toContain('- tab "Billing" [selected] [ref=e2]');
  });

  test("does not give a ref to an interactive role without a DOM node", () => {
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "Page", childIds: ["2"] }),
        node("2", "button", { name: "Orphan", parentId: "1" }),
      ),
    );

    expect(snapshot.refs.size).toBe(0);
    expect(snapshot.text).toContain('- button "Orphan"');
  });

  test("collapses whitespace and shortens long names", () => {
    const long = `${"word ".repeat(80)}end`;
    const snapshot = buildSnapshot(
      tree(
        node("1", "RootWebArea", { name: "  Spaced \n  title ", childIds: ["2"] }),
        node("2", "heading", { name: long, parentId: "1" }),
      ),
    );

    const lines = snapshot.text.split("\n");
    expect(lines[0]).toBe('- page "Spaced title"');
    expect(lines[1]?.endsWith('…"')).toBe(true);
    expect((lines[1] ?? "").length).toBeLessThan(200);
  });

  test("stops at the character cap and says so", () => {
    const paragraphs = Array.from({ length: 400 }, (_, index) =>
      node(String(index + 2), "paragraph", {
        name: `Paragraph number ${String(index)} with enough text to fill the page`,
        parentId: "1",
      }),
    );
    const root = node("1", "RootWebArea", {
      name: "Long",
      childIds: paragraphs.map((paragraph) => paragraph.nodeId),
    });

    const snapshot = buildSnapshot(tree(root, ...paragraphs), 2_000);

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.length).toBeLessThan(2_300);
    expect(snapshot.text.split("\n").at(-1)).toBe("… page outline truncated at 2000 characters");
  });

  test("uses a cap that keeps a page outline around six thousand tokens", () => {
    expect(SNAPSHOT_CHARACTER_CAP).toBe(24_000);
  });

  test("returns an empty snapshot for an empty tree", () => {
    const snapshot = buildSnapshot([]);

    expect(snapshot.text).toBe("");
    expect(snapshot.refs.size).toBe(0);
  });
});

describe("snapshotWindow", () => {
  function longSnapshot(headingCount: number) {
    const headings = Array.from({ length: headingCount }, (_, index) =>
      node(String(index + 2), "heading", {
        name: `Heading number ${String(index)}`,
        parentId: "1",
      }),
    );
    return buildSnapshot(
      tree(
        node("1", "RootWebArea", {
          name: "Long",
          childIds: headings.map((heading) => heading.nodeId),
        }),
        ...headings,
      ),
    );
  }

  test("returns the whole outline when it fits", () => {
    const snapshot = longSnapshot(3);

    const window = snapshotWindow(snapshot);

    expect(window.text).toBe(snapshot.text);
    expect(window.nextStartLine).toBeUndefined();
  });

  test("ends a long outline with the line that continues it", () => {
    const snapshot = longSnapshot(50);

    const first = snapshotWindow(snapshot, 1, 300);

    expect(first.nextStartLine).toBeDefined();
    const remaining = snapshot.lines.length - (first.nextStartLine ?? 0) + 1;
    expect(first.text.split("\n").at(-1)).toBe(
      `… ${String(remaining)} more lines; call browser_snapshot with startLine=${String(first.nextStartLine)} to continue`,
    );
  });

  test("paging through with nextStartLine shows every line exactly once", () => {
    const snapshot = longSnapshot(60);
    const seen: string[] = [];
    let startLine: number | undefined = 1;

    while (startLine !== undefined) {
      const window = snapshotWindow(snapshot, startLine, 400);
      const lines = window.text.split("\n");
      seen.push(...(window.nextStartLine === undefined ? lines : lines.slice(0, -1)));
      startLine = window.nextStartLine;
    }

    expect(seen).toEqual([...snapshot.lines]);
  });

  test("always returns at least one line, even one longer than the window", () => {
    const snapshot = longSnapshot(5);

    const window = snapshotWindow(snapshot, 2, 5);

    expect(window.text.split("\n")[0]).toBe(snapshot.lines[1]);
  });

  test("a start line past the end returns nothing", () => {
    const snapshot = longSnapshot(3);

    expect(snapshotWindow(snapshot, 999)).toEqual({ text: "", nextStartLine: undefined });
  });
});
