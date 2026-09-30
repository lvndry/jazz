/**
 * Turns Chrome's accessibility tree into the compact text a model reads to drive a page.
 *
 * Each interactive element gets a short ref (`e1`, `e2`, …) that the action tools take back.
 * A ref maps to the node's `backendDOMNodeId`, which stays valid while the node is in the
 * document, so it survives until the next navigation or until the page removes the element.
 * Decoration is dropped: ignored nodes, unnamed generic containers, and static text that an
 * ancestor's name already repeats (a link's own label, say).
 */

/** The fields of a CDP `Accessibility.AXNode` this module reads. */
export interface AccessibilityNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: readonly {
    readonly name: string;
    readonly value?: { readonly value?: unknown };
  }[];
  readonly parentId?: string;
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
}

/** Characters of snapshot text returned at most: about 6,000 tokens of page structure. */
export const SNAPSHOT_CHARACTER_CAP = 24_000;

/** Longest accessible name printed for one element. */
const MAX_NAME_CHARACTERS = 160;

/** Longest field value printed for one element. */
const MAX_VALUE_CHARACTERS = 120;

/** Longest link target printed for one link. */
const MAX_URL_CHARACTERS = 200;

const ELLIPSIS = "…";

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
  "treeitem",
  "listbox",
]);

/** Roles that carry no meaning of their own: their children are printed at the same depth. */
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "none",
  "presentation",
  "GenericContainer",
  "InlineTextBox",
  "LineBreak",
  "Section",
]);

/** Roles whose `value` (the text in a field) is worth printing. */
const VALUE_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "slider",
  "spinbutton",
]);

/** Properties printed after the name, in this order. */
const PRINTED_PROPERTIES: readonly string[] = [
  "level",
  "checked",
  "selected",
  "expanded",
  "disabled",
  "required",
];

const TRUE_ONLY_PROPERTIES: ReadonlySet<string> = new Set(["disabled", "required", "selected"]);

/** What a ref points at: the DOM node, and how to name it to a person (`button "Sign in"`). */
export interface SnapshotRef {
  readonly backendNodeId: number;
  readonly label: string;
}

export interface PageSnapshot {
  readonly text: string;
  /** Every interactive element printed, by ref. */
  readonly refs: ReadonlyMap<string, SnapshotRef>;
  readonly truncated: boolean;
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function tidy(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  return `${collapsed.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}

function quoted(text: string): string {
  return JSON.stringify(text);
}

function propertyValue(node: AccessibilityNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value?.value;
}

function describeProperties(node: AccessibilityNode): string {
  const parts: string[] = [];
  for (const name of PRINTED_PROPERTIES) {
    const value = propertyValue(node, name);
    if (value === undefined || value === null) {
      continue;
    }
    if (TRUE_ONLY_PROPERTIES.has(name)) {
      if (value === true) {
        parts.push(name);
      }
      continue;
    }
    parts.push(`${name}=${asText(value)}`);
  }
  return parts.length === 0 ? "" : ` [${parts.join(", ")}]`;
}

/**
 * The snapshot text for `nodes`, the flat result of `Accessibility.getFullAXTree`.
 *
 * Output stops at `characterCap` characters and ends with a line saying so.
 */
export function buildSnapshot(
  nodes: readonly AccessibilityNode[],
  characterCap: number = SNAPSHOT_CHARACTER_CAP,
): PageSnapshot {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => node.parentId === undefined);
  const refs = new Map<string, SnapshotRef>();
  const lines: string[] = [];
  let characters = 0;
  let truncated = false;

  function emit(depth: number, line: string): boolean {
    const indented = `${"  ".repeat(depth)}${line}`;
    if (characters + indented.length + 1 > characterCap) {
      truncated = true;
      return false;
    }
    lines.push(indented);
    characters += indented.length + 1;
    return true;
  }

  function visit(node: AccessibilityNode, depth: number, ancestorName: string): boolean {
    const role = asText(node.role?.value);
    const name = tidy(asText(node.name?.value), MAX_NAME_CHARACTERS);
    const children = node.childIds ?? [];

    function visitChildren(childDepth: number, nameAbove: string): boolean {
      for (const childId of children) {
        const child = byId.get(childId);
        if (child !== undefined && !visit(child, childDepth, nameAbove)) {
          return false;
        }
      }
      return true;
    }

    if (node.ignored === true || role === "InlineTextBox" || role === "LineBreak") {
      return visitChildren(depth, ancestorName);
    }

    if (role === "StaticText") {
      if (name === "" || (ancestorName !== "" && ancestorName.includes(name))) {
        return true;
      }
      return emit(depth, `text ${quoted(name)}`);
    }

    if (TRANSPARENT_ROLES.has(role) && name === "") {
      return visitChildren(depth, ancestorName);
    }

    const label = role === "RootWebArea" ? "page" : role;
    let line = `- ${label}`;
    if (name !== "") {
      line += ` ${quoted(name)}`;
    }
    if (VALUE_ROLES.has(role)) {
      const fieldValue = tidy(asText(node.value?.value), MAX_VALUE_CHARACTERS);
      if (fieldValue !== "") {
        line += ` = ${quoted(fieldValue)}`;
      }
    }
    line += describeProperties(node);
    if (role === "link") {
      const target = tidy(asText(propertyValue(node, "url")), MAX_URL_CHARACTERS);
      if (target !== "") {
        line += ` -> ${target}`;
      }
    }

    if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined) {
      const ref = `e${String(refs.size + 1)}`;
      refs.set(ref, {
        backendNodeId: node.backendDOMNodeId,
        label: name === "" ? role : `${role} ${quoted(name)}`,
      });
      line += ` [ref=${ref}]`;
    }

    if (!emit(depth, line)) {
      return false;
    }
    return visitChildren(depth + 1, name === "" ? ancestorName : name);
  }

  if (root !== undefined) {
    visit(root, 0, "");
  }

  if (truncated) {
    lines.push(
      `… snapshot truncated at ${String(characterCap)} characters; scroll or navigate to see more`,
    );
  }

  return { text: lines.join("\n"), refs, truncated };
}
