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

/** Characters of snapshot text returned by one call: about 6,000 tokens of page structure. */
export const SNAPSHOT_CHARACTER_CAP = 24_000;

/** Characters of outline built for a whole page; a page past this ends with a note saying so. */
export const SNAPSHOT_TOTAL_CAP = 240_000;

/** Longest accessible name printed for one element. */
const MAX_NAME_CHARACTERS = 160;

/** Longest run of page text printed on one line; the snapshot cap bounds the total. */
const MAX_TEXT_CHARACTERS = 2_000;

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

/** Page text gathered between printed nodes, printed as one line. */
interface TextRun {
  text: string;
}

/** Roles that mean "no semantics" whatever name a browser computes for them. */
const PRESENTATIONAL_ROLES: ReadonlySet<string> = new Set(["none", "presentation"]);

/** Roles that carry no meaning of their own: their children are printed at the same depth. */
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "GenericContainer",
  "InlineTextBox",
  "LineBreak",
  "Section",
  "paragraph",
  "LabelText",
  "MenuListPopup",
]);

/**
 * Roles whose accessible name is built from their own text, so a text child repeating that name
 * adds nothing. The page, a region or a labelled group is not among them: their names come from
 * a title or an `aria-label`, and text that happens to appear in one is still content.
 */
const CONTENT_NAMED_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "heading",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "checkbox",
  "radio",
  "switch",
  "cell",
  "columnheader",
  "rowheader",
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
  /** The whole outline, one entry per line. */
  readonly lines: readonly string[];
  readonly text: string;
  /** Every interactive element printed, by ref. */
  readonly refs: ReadonlyMap<string, SnapshotRef>;
  /** Whether the page outline was cut at the whole-page cap. */
  readonly truncated: boolean;
}

export interface SnapshotWindow {
  readonly text: string;
  /** The line to ask for next when the window ends before the outline does. */
  readonly nextStartLine: number | undefined;
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
  characterCap: number = SNAPSHOT_TOTAL_CAP,
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

  function flushRun(run: TextRun, depth: number, ancestorName: string): boolean {
    const runText = tidy(run.text, MAX_TEXT_CHARACTERS);
    run.text = "";
    if (runText === "" || (ancestorName !== "" && ancestorName.includes(runText))) {
      return true;
    }
    return emit(depth, `text ${quoted(runText)}`);
  }

  /**
   * `run` collects the page text between one printed node and the next, so text a page splits
   * across spans, or across one wrapper per character, prints as one line. Nodes that print
   * nothing pass their parent's run and depth straight through.
   */
  function visit(
    node: AccessibilityNode,
    depth: number,
    ancestorName: string,
    run: TextRun,
  ): boolean {
    const role = asText(node.role?.value);
    const name = tidy(asText(node.name?.value), MAX_NAME_CHARACTERS);

    function visitChildren(childDepth: number, nameAbove: string, childRun: TextRun): boolean {
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child !== undefined && !visit(child, childDepth, nameAbove, childRun)) {
          return false;
        }
      }
      return true;
    }

    if (node.ignored === true || role === "InlineTextBox" || role === "LineBreak") {
      return visitChildren(depth, ancestorName, run);
    }

    if (role === "StaticText") {
      run.text += asText(node.name?.value);
      return true;
    }

    if (PRESENTATIONAL_ROLES.has(role) || (TRANSPARENT_ROLES.has(role) && name === "")) {
      return visitChildren(depth, ancestorName, run);
    }

    if (!flushRun(run, depth, ancestorName)) {
      return false;
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
    const nameForChildren = CONTENT_NAMED_ROLES.has(role) ? name : "";
    const childRun: TextRun = { text: "" };
    return (
      visitChildren(depth + 1, nameForChildren, childRun) &&
      flushRun(childRun, depth + 1, nameForChildren)
    );
  }

  if (root !== undefined) {
    const rootRun: TextRun = { text: "" };
    if (visit(root, 0, "", rootRun)) {
      flushRun(rootRun, 0, "");
    }
  }

  if (truncated) {
    lines.push(`… page outline truncated at ${String(characterCap)} characters`);
  }

  return { lines, text: lines.join("\n"), refs, truncated };
}

/**
 * The part of `snapshot` a single call returns: lines from `startLine` (1-based) while they fit
 * in `windowCap` characters, always at least one. When lines remain, the text ends with a note
 * giving the `startLine` that continues it.
 */
export function snapshotWindow(
  snapshot: PageSnapshot,
  startLine: number = 1,
  windowCap: number = SNAPSHOT_CHARACTER_CAP,
): SnapshotWindow {
  const firstIndex = Math.max(0, Math.min(startLine - 1, snapshot.lines.length));
  let characters = 0;
  let endIndex = firstIndex;
  while (endIndex < snapshot.lines.length) {
    const length = (snapshot.lines[endIndex] ?? "").length + 1;
    if (endIndex > firstIndex && characters + length > windowCap) {
      break;
    }
    characters += length;
    endIndex += 1;
  }
  const shown = snapshot.lines.slice(firstIndex, endIndex);
  if (endIndex >= snapshot.lines.length) {
    return { text: shown.join("\n"), nextStartLine: undefined };
  }
  const nextStartLine = endIndex + 1;
  const remaining = snapshot.lines.length - endIndex;
  const note = `… ${String(remaining)} more lines; call browser_snapshot with startLine=${String(nextStartLine)} to continue`;
  return { text: [...shown, note].join("\n"), nextStartLine };
}
