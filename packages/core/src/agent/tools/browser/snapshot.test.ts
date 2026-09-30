import { describe, expect, test } from "bun:test";
import { type AccessibilityNode, buildSnapshot, SNAPSHOT_CHARACTER_CAP } from "./snapshot";

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
    expect(snapshot.text.split("\n").at(-1)).toBe(
      "… snapshot truncated at 2000 characters; scroll or navigate to see more",
    );
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
