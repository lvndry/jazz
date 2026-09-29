/**
 * @fileoverview LaTeX math rendered as Unicode text, for surfaces that cannot typeset.
 *
 * A terminal or a chat bubble has no math layout, so the source is flattened onto the
 * line: Greek and operator names become their glyphs, `^` and `_` become super- and
 * subscript characters where Unicode has them (and `^(…)` / `_(…)` where it does not),
 * fractions become `a/b` or a vulgar fraction, and matrices and aligned equations become
 * rows of padded cells. A command this file does not know is left as typed, so nothing is
 * silently dropped.
 */

const COMBINING_MARK = /[\u0300-\u036f\u20d0-\u20ff]/u;

/** Cells a string occupies: code points, without the combining marks that sit on their base. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    if (!COMBINING_MARK.test(character)) {
      width += 1;
    }
  }
  return width;
}

/** `name glyph name glyph …` pairs, split on whitespace. */
function table(entries: string): Map<string, string> {
  const words = entries.trim().split(/\s+/);
  const result = new Map<string, string>();
  for (let position = 0; position + 1 < words.length; position += 2) {
    result.set(words[position] ?? "", words[position + 1] ?? "");
  }
  return result;
}

const SYMBOLS = table(`
alpha α beta β gamma γ delta δ epsilon ϵ varepsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι
kappa κ varkappa ϰ lambda λ mu μ nu ν xi ξ pi π varpi ϖ rho ρ varrho ϱ sigma σ varsigma ς tau τ
upsilon υ phi ϕ varphi φ chi χ psi ψ omega ω
Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Upsilon Υ Phi Φ Psi Ψ Omega Ω
sum ∑ prod ∏ coprod ∐ int ∫ iint ∬ iiint ∭ oint ∮ bigcup ⋃ bigcap ⋂ bigoplus ⨁ bigotimes ⨂
bigwedge ⋀ bigvee ⋁
pm ± mp ∓ times × div ÷ cdot ⋅ cdotp ⋅ ast ∗ star ⋆ circ ∘ bullet ∙ oplus ⊕ ominus ⊖ otimes ⊗
oslash ⊘ odot ⊙ cup ∪ cap ∩ setminus ∖ smallsetminus ∖ wedge ∧ land ∧ vee ∨ lor ∨ neg ¬ lnot ¬
uplus ⊎ sqcup ⊔ sqcap ⊓ dagger † ddagger ‡ wr ≀ amalg ⨿
leq ≤ le ≤ geq ≥ ge ≥ neq ≠ ne ≠ approx ≈ approxeq ≊ equiv ≡ sim ∼ simeq ≃ cong ≅ propto ∝
ll ≪ gg ≫ prec ≺ succ ≻ preceq ⪯ succeq ⪰ asymp ≍ doteq ≐ triangleq ≜ coloneqq ≔ eqqcolon ≕
subset ⊂ supset ⊃ subseteq ⊆ supseteq ⊇ subsetneq ⊊ supsetneq ⊋ sqsubseteq ⊑ sqsupseteq ⊒
in ∈ notin ∉ ni ∋ forall ∀ exists ∃ nexists ∄ emptyset ∅ varnothing ∅ infty ∞ partial ∂ nabla ∇
prime ′ angle ∠ measuredangle ∡ perp ⊥ bot ⊥ top ⊤ parallel ∥ nparallel ∦ mid ∣ nmid ∤
vdash ⊢ dashv ⊣ models ⊨ therefore ∴ because ∵ hbar ℏ ell ℓ Re ℜ Im ℑ aleph ℵ beth ℶ wp ℘
imath ı jmath ȷ degree ° triangle △ square □ blacksquare ■ diamond ⋄ lozenge ◊ checkmark ✓
to → rightarrow → leftarrow ← gets ← leftrightarrow ↔ Rightarrow ⇒ Leftarrow ⇐
Leftrightarrow ⇔ iff ⟺ implies ⟹ impliedby ⟸ mapsto ↦ longrightarrow ⟶ longleftarrow ⟵
longleftrightarrow ⟷ Longrightarrow ⟹ Longleftarrow ⟸ Longleftrightarrow ⟺ longmapsto ⟼
uparrow ↑ downarrow ↓ updownarrow ↕ Uparrow ⇑ Downarrow ⇓ nearrow ↗ searrow ↘ swarrow ↙
nwarrow ↖ hookrightarrow ↪ hookleftarrow ↩ rightharpoonup ⇀ rightharpoondown ⇁
leftharpoonup ↼ leftharpoondown ↽ rightleftharpoons ⇌ leadsto ⇝ nrightarrow ↛ nleftarrow ↚
ldots … dots … dotsc … dotsb ⋯ cdots ⋯ vdots ⋮ ddots ⋱ textellipsis …
langle ⟨ rangle ⟩ lfloor ⌊ rfloor ⌋ lceil ⌈ rceil ⌉ lvert | rvert | lVert ‖ rVert ‖ vert |
Vert ‖ | ‖ lbrace { rbrace } lbrack [ rbrack ] backslash \\ { { } } % % $ $ & & # # _ _ textbackslash \\
ldotp . colon : lgroup ⟮ rgroup ⟯ textbar | textasciitilde ~ textunderscore _ textdollar $
S § P ¶ copyright © pounds £ euro € yen ¥ AA Å ss ß ae æ AE Æ oe œ OE Œ o ø O Ø i ı
`);

const OPERATOR_NAMES = new Set(
  (
    "sin cos tan cot sec csc arcsin arccos arctan arccot sinh cosh tanh coth sech csch log ln " +
    "lg exp det dim ker deg gcd lcm max min sup inf lim limsup liminf arg Pr hom tr rank sgn " +
    "argmax argmin sign"
  ).split(" "),
);

const SPACING = new Map<string, string>([
  [",", " "],
  [";", " "],
  [":", " "],
  [">", " "],
  [" ", " "],
  ["!", ""],
  ["-", ""],
  ["/", ""],
  ["quad", "  "],
  ["qquad", "    "],
  ["enspace", " "],
  ["thinspace", " "],
  ["medspace", " "],
  ["thickspace", " "],
  ["negthinspace", ""],
  ["mod", " mod "],
  ["bmod", " mod "],
]);

/** Commands that only affect typesetting, and take no argument. */
const IGNORED = new Set([
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "scriptscriptstyle",
  "limits",
  "nolimits",
  "nonumber",
  "notag",
  "hline",
  "hfill",
  "centering",
  "protect",
  "relax",
  "allowbreak",
  "nobreak",
]);

/** Commands that take one argument and discard it. */
const DISCARDED_ARGUMENT = new Set(["label", "color", "vphantom", "hypertarget", "ref", "eqref"]);

/** Commands that wrap their argument without changing it. */
const TRANSPARENT = new Set([
  "mathop",
  "mathbin",
  "mathrel",
  "mathord",
  "mathopen",
  "mathclose",
  "mathpunct",
  "mathrm",
  "mathit",
  "mathsf",
  "mathtt",
  "mathnormal",
  "underbrace",
  "overbrace",
  "underbracket",
  "overbracket",
  "boldmath",
]);

const RAW_TEXT = new Set([
  "text",
  "textrm",
  "textit",
  "textbf",
  "textsf",
  "texttt",
  "mbox",
  "hbox",
]);

const DELIMITER_SIZING = new Set([
  "left",
  "right",
  "middle",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "Biggl",
  "Biggr",
]);

const SUPERSCRIPTS = table(`
0 ⁰ 1 ¹ 2 ² 3 ³ 4 ⁴ 5 ⁵ 6 ⁶ 7 ⁷ 8 ⁸ 9 ⁹ + ⁺ - ⁻ − ⁻ = ⁼ ( ⁽ ) ⁾ ′ ′ ° °
a ᵃ b ᵇ c ᶜ d ᵈ e ᵉ f ᶠ g ᵍ h ʰ i ⁱ j ʲ k ᵏ l ˡ m ᵐ n ⁿ o ᵒ p ᵖ r ʳ s ˢ t ᵗ u ᵘ v ᵛ w ʷ x ˣ
y ʸ z ᶻ
A ᴬ B ᴮ D ᴰ E ᴱ G ᴳ H ᴴ I ᴵ J ᴶ K ᴷ L ᴸ M ᴹ N ᴺ O ᴼ P ᴾ R ᴿ T ᵀ U ᵁ V ⱽ W ᵂ
β ᵝ γ ᵞ δ ᵟ θ ᶿ φ ᵠ χ ᵡ
`);

const SUBSCRIPTS = table(`
0 ₀ 1 ₁ 2 ₂ 3 ₃ 4 ₄ 5 ₅ 6 ₆ 7 ₇ 8 ₈ 9 ₉ + ₊ - ₋ − ₋ = ₌ ( ₍ ) ₎
a ₐ e ₑ h ₕ i ᵢ j ⱼ k ₖ l ₗ m ₘ n ₙ o ₒ p ₚ r ᵣ s ₛ t ₜ u ᵤ v ᵥ x ₓ
β ᵦ γ ᵧ ρ ᵨ φ ᵩ χ ᵪ
`);

const VULGAR_FRACTIONS = table(`
1/2 ½ 1/3 ⅓ 2/3 ⅔ 1/4 ¼ 3/4 ¾ 1/5 ⅕ 2/5 ⅖ 3/5 ⅗ 4/5 ⅘ 1/6 ⅙ 5/6 ⅚ 1/8 ⅛ 3/8 ⅜ 5/8 ⅝ 7/8 ⅞
`);

const ROOTS = table("2 √ 3 ∛ 4 ∜");

/** Relations that have a single-glyph negation, so `\not\in` is `∉` and not `∈` plus a slash. */
const NEGATIONS = table(`
= ≠ < ≮ > ≯ ∈ ∉ ∋ ∌ ∃ ∄ ⊂ ⊄ ⊃ ⊅ ⊆ ⊈ ⊇ ⊉ ≤ ≰ ≥ ≱ ≡ ≢ ∼ ≁ ≃ ≄ ≅ ≇ ≈ ≉ ∣ ∤ ∥ ∦ → ↛ ← ↚ ↔ ↮
⇒ ⇏ ⇔ ⇎ ⊢ ⊬ ⊨ ⊭ ≺ ⊀ ≻ ⊁
`);

interface Alphabet {
  readonly upper: number;
  readonly lower: number;
  readonly digit?: number;
  readonly exceptions: ReadonlyMap<string, string>;
}

const BOLD: Alphabet = { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce, exceptions: new Map() };
const DOUBLE_STRUCK: Alphabet = {
  upper: 0x1d538,
  lower: 0x1d552,
  digit: 0x1d7d8,
  exceptions: table("C ℂ H ℍ N ℕ P ℙ Q ℚ R ℝ Z ℤ"),
};
const SCRIPT: Alphabet = {
  upper: 0x1d49c,
  lower: 0x1d4b6,
  exceptions: table("B ℬ E ℰ F ℱ H ℋ I ℐ L ℒ M ℳ R ℛ e ℯ g ℊ o ℴ"),
};
const FRAKTUR: Alphabet = {
  upper: 0x1d504,
  lower: 0x1d51e,
  exceptions: table("C ℭ H ℌ I ℑ R ℜ Z ℨ"),
};

const ALPHABETS = new Map<string, Alphabet>([
  ["mathbf", BOLD],
  ["boldsymbol", BOLD],
  ["bm", BOLD],
  ["mathbb", DOUBLE_STRUCK],
  ["Bbb", DOUBLE_STRUCK],
  ["mathcal", SCRIPT],
  ["mathscr", SCRIPT],
  ["mathfrak", FRAKTUR],
]);

const ACCENTS = new Map<string, string>([
  ["hat", "\u0302"],
  ["widehat", "\u0302"],
  ["check", "\u030c"],
  ["tilde", "\u0303"],
  ["widetilde", "\u0303"],
  ["acute", "\u0301"],
  ["grave", "\u0300"],
  ["dot", "\u0307"],
  ["ddot", "\u0308"],
  ["dddot", "\u20db"],
  ["breve", "\u0306"],
  ["bar", "\u0304"],
  ["overline", "\u0305"],
  ["underline", "\u0332"],
  ["vec", "\u20d7"],
  ["overrightarrow", "\u20d7"],
  ["overleftarrow", "\u20d6"],
  ["mathring", "\u030a"],
]);

/** Accents that run across every character of their argument rather than sitting on the last. */
const SPANNING_ACCENTS = new Set(["overline", "underline", "widehat", "widetilde"]);

function styleLetters(text: string, alphabet: Alphabet): string {
  let styled = "";
  for (const character of text) {
    const exception = alphabet.exceptions.get(character);
    if (exception !== undefined) {
      styled += exception;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code >= 65 && code <= 90) {
      styled += String.fromCodePoint(alphabet.upper + code - 65);
    } else if (code >= 97 && code <= 122) {
      styled += String.fromCodePoint(alphabet.lower + code - 97);
    } else if (alphabet.digit !== undefined && code >= 48 && code <= 57) {
      styled += String.fromCodePoint(alphabet.digit + code - 48);
    } else {
      styled += character;
    }
  }
  return styled;
}

function applyAccent(text: string, name: string, mark: string): string {
  if (text.length === 0) {
    return text;
  }
  const characters = [...text];
  if (SPANNING_ACCENTS.has(name)) {
    return characters.map((character) => `${character}${mark}`).join("");
  }
  const last = characters.pop() ?? "";
  return `${characters.join("")}${last}${mark}`;
}

function toScript(rendered: string, glyphs: ReadonlyMap<string, string>, marker: string): string {
  let converted = "";
  for (const character of rendered.replace(/\s+/g, "")) {
    const glyph = glyphs.get(character);
    if (glyph === undefined) {
      return [...rendered].length === 1 ? `${marker}${rendered}` : `${marker}(${rendered})`;
    }
    converted += glyph;
  }
  return converted;
}

/** One operand: letters, digits and scripts, possibly with a bracketed group such as `f(x)` or `(a−b)²`. */
function isAtom(text: string): boolean {
  return /^(?:[\p{L}\p{N}\p{M}.′]|\([^()]*\))+$/u.test(text);
}

/** A radicand that needs no brackets to read unambiguously: one symbol or one number. */
function isSimpleRadicand(text: string): boolean {
  return /^(?:[\p{L}\p{N}\p{M}′]|\p{N}+(?:\.\p{N}+)?)$/u.test(text);
}

function isWrapped(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) {
    return false;
  }
  let depth = 0;
  for (let position = 0; position < text.length; position += 1) {
    if (text[position] === "(") {
      depth += 1;
    } else if (text[position] === ")") {
      depth -= 1;
      if (depth === 0 && position < text.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

function group(text: string): string {
  return isAtom(text) || isWrapped(text) ? text : `(${text})`;
}

interface Cursor {
  readonly source: string;
  index: number;
}

function skipWhitespace(cursor: Cursor): void {
  while (cursor.index < cursor.source.length && /\s/.test(cursor.source[cursor.index] ?? "")) {
    cursor.index += 1;
  }
}

/** Reads the `{…}` the cursor is on, returning what is inside and leaving the cursor after it. */
function readGroup(cursor: Cursor): string {
  const start = cursor.index + 1;
  let depth = 0;
  for (let position = cursor.index; position < cursor.source.length; position += 1) {
    const character = cursor.source[position];
    if (character === "\\") {
      position += 1;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        cursor.index = position + 1;
        return cursor.source.slice(start, position);
      }
    }
  }
  cursor.index = cursor.source.length;
  return cursor.source.slice(start);
}

const CONTROL_TOKEN = /\\(?:[A-Za-z]+|[\s\S])/y;

/** A TeX argument: a braced group, a whole control sequence, or a single character. */
function readArgument(cursor: Cursor): string {
  skipWhitespace(cursor);
  const character = cursor.source[cursor.index];
  if (character === undefined) {
    return "";
  }
  if (character === "{") {
    return readGroup(cursor);
  }
  if (character === "\\") {
    CONTROL_TOKEN.lastIndex = cursor.index;
    const token = CONTROL_TOKEN.exec(cursor.source)?.[0] ?? "\\";
    cursor.index += token.length;
    return token;
  }
  const single = String.fromCodePoint(cursor.source.codePointAt(cursor.index) ?? 0);
  cursor.index += single.length;
  return single;
}

/** The `[…]` that may follow a command such as `\sqrt`. */
function readOptional(cursor: Cursor): string | undefined {
  skipWhitespace(cursor);
  if (cursor.source[cursor.index] !== "[") {
    return undefined;
  }
  const close = cursor.source.indexOf("]", cursor.index);
  if (close === -1) {
    return undefined;
  }
  const inside = cursor.source.slice(cursor.index + 1, close);
  cursor.index = close + 1;
  return inside;
}

const COMMAND_NAME = /[A-Za-z]+/y;

function readCommandName(cursor: Cursor): string {
  COMMAND_NAME.lastIndex = cursor.index;
  const letters = COMMAND_NAME.exec(cursor.source)?.[0];
  if (letters !== undefined) {
    cursor.index += letters.length;
    return letters;
  }
  const single = cursor.source[cursor.index] ?? "";
  cursor.index += single.length;
  return single;
}

const OPTIONAL_LINE_SPACING = /\[\s*-?[\d.]+\s*(?:pt|em|ex|mm|cm|in)\s*\]/y;
const LIMIT_MODIFIER = /\s*\\(?:no)?limits(?![A-Za-z])/y;

function skipLimitModifier(cursor: Cursor): void {
  LIMIT_MODIFIER.lastIndex = cursor.index;
  const matched = LIMIT_MODIFIER.exec(cursor.source)?.[0];
  if (matched !== undefined) {
    cursor.index += matched.length;
  }
}

/** A function name reads as a word, so it is set off from a letter or command that follows. */
function withTrailingSpace(cursor: Cursor, name: string): string {
  skipLimitModifier(cursor);
  return /[\p{L}\p{N}\\]/u.test(cursor.source[cursor.index] ?? "") ? `${name} ` : name;
}

interface Bracket {
  readonly single: string;
  readonly top: string;
  readonly middle: string;
  readonly bottom: string;
  readonly center?: string;
}

const PAREN_LEFT: Bracket = { single: "(", top: "⎛", middle: "⎜", bottom: "⎝" };
const PAREN_RIGHT: Bracket = { single: ")", top: "⎞", middle: "⎟", bottom: "⎠" };
const SQUARE_LEFT: Bracket = { single: "[", top: "⎡", middle: "⎢", bottom: "⎣" };
const SQUARE_RIGHT: Bracket = { single: "]", top: "⎤", middle: "⎥", bottom: "⎦" };
const BRACE_LEFT: Bracket = { single: "{", top: "⎧", middle: "⎪", bottom: "⎩", center: "⎨" };
const BRACE_RIGHT: Bracket = { single: "}", top: "⎫", middle: "⎪", bottom: "⎭", center: "⎬" };
const BAR: Bracket = { single: "|", top: "│", middle: "│", bottom: "│" };
const DOUBLE_BAR: Bracket = { single: "‖", top: "║", middle: "║", bottom: "║" };

type ColumnAlignment = "left" | "center" | "alternate";

interface EnvironmentStyle {
  readonly alignment: ColumnAlignment;
  readonly gap: string;
  readonly left?: Bracket;
  readonly right?: Bracket;
  /** `array` and `alignat` open with a column specification that is not content. */
  readonly skipSpecification?: boolean;
}

const MATRIX: EnvironmentStyle = { alignment: "center", gap: "  " };
const ALIGNED: EnvironmentStyle = { alignment: "alternate", gap: " " };

const ENVIRONMENTS = new Map<string, EnvironmentStyle>([
  ["matrix", MATRIX],
  ["smallmatrix", MATRIX],
  ["pmatrix", { ...MATRIX, left: PAREN_LEFT, right: PAREN_RIGHT }],
  ["bmatrix", { ...MATRIX, left: SQUARE_LEFT, right: SQUARE_RIGHT }],
  ["Bmatrix", { ...MATRIX, left: BRACE_LEFT, right: BRACE_RIGHT }],
  ["vmatrix", { ...MATRIX, left: BAR, right: BAR }],
  ["Vmatrix", { ...MATRIX, left: DOUBLE_BAR, right: DOUBLE_BAR }],
  ["array", { alignment: "left", gap: "  ", skipSpecification: true }],
  ["cases", { alignment: "left", gap: "  ", left: BRACE_LEFT }],
  ["align", ALIGNED],
  ["aligned", ALIGNED],
  ["alignat", { ...ALIGNED, skipSpecification: true }],
  ["alignedat", { ...ALIGNED, skipSpecification: true }],
  ["flalign", ALIGNED],
  ["split", ALIGNED],
  ["eqnarray", ALIGNED],
]);

const STACKED: EnvironmentStyle = { alignment: "left", gap: " " };

/** Environments that stand on their own line when written outside `$$ … $$`. */
export const DISPLAY_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "aligned",
  "alignat",
  "alignat*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "flalign",
  "flalign*",
  "eqnarray",
  "eqnarray*",
  "split",
  "displaymath",
  "math",
]);

function bracketGlyph(bracket: Bracket, rowCount: number, rowIndex: number): string {
  if (rowCount === 1) {
    return bracket.single;
  }
  if (rowIndex === 0) {
    return bracket.top;
  }
  if (rowIndex === rowCount - 1) {
    return bracket.bottom;
  }
  if (bracket.center !== undefined && rowCount % 2 === 1 && rowIndex === (rowCount - 1) / 2) {
    return bracket.center;
  }
  return bracket.middle;
}

function pad(text: string, width: number, alignment: "left" | "right" | "center"): string {
  const gap = Math.max(0, width - displayWidth(text));
  if (alignment === "left") {
    return text + " ".repeat(gap);
  }
  if (alignment === "right") {
    return " ".repeat(gap) + text;
  }
  const before = Math.floor(gap / 2);
  return " ".repeat(before) + text + " ".repeat(gap - before);
}

/** Splits an environment body into rows on `\\` and cells on `&`, outside nested groups. */
function splitRows(body: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let braceDepth = 0;
  let environmentDepth = 0;
  let position = 0;
  while (position < body.length) {
    const character = body[position] ?? "";
    if (character === "\\") {
      if (body[position + 1] === "\\" && braceDepth === 0 && environmentDepth === 0) {
        cells.push(cell);
        rows.push(cells);
        cells = [];
        cell = "";
        position += 2;
        OPTIONAL_LINE_SPACING.lastIndex = position;
        const spacing = OPTIONAL_LINE_SPACING.exec(body)?.[0];
        position += spacing?.length ?? 0;
        continue;
      }
      if (body.startsWith("\\begin{", position)) {
        environmentDepth += 1;
      } else if (body.startsWith("\\end{", position)) {
        environmentDepth -= 1;
      }
      cell += body.slice(position, position + 2);
      position += 2;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth -= 1;
    } else if (character === "&" && braceDepth === 0 && environmentDepth === 0) {
      cells.push(cell);
      cell = "";
      position += 1;
      continue;
    }
    cell += character;
    position += 1;
  }
  if (cell.trim().length > 0 || cells.length > 0) {
    cells.push(cell);
    rows.push(cells);
  }
  return rows;
}

function dropLeadingGroup(body: string): string {
  const cursor: Cursor = { source: body, index: 0 };
  skipWhitespace(cursor);
  if (cursor.source[cursor.index] !== "{") {
    return body;
  }
  readGroup(cursor);
  return body.slice(cursor.index);
}

function layoutEnvironment(name: string, body: string): string {
  const style = ENVIRONMENTS.get(name.replace(/\*$/, "")) ?? STACKED;
  const rows = splitRows(style.skipSpecification === true ? dropLeadingGroup(body) : body).map(
    (row) =>
      row.map((cell) =>
        renderFragment(cell)
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      ),
  );
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    widths.push(Math.max(0, ...rows.map((row) => displayWidth(row[column] ?? ""))));
  }
  const lines = rows.map((row, rowIndex) => {
    const cells: string[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      const alignment =
        style.alignment === "alternate" ? (column % 2 === 0 ? "right" : "left") : style.alignment;
      cells.push(pad(row[column] ?? "", widths[column] ?? 0, alignment));
    }
    const joined = cells.join(style.gap);
    const opening =
      style.left === undefined ? "" : `${bracketGlyph(style.left, rows.length, rowIndex)} `;
    if (style.right === undefined) {
      return `${opening}${joined}`.trimEnd();
    }
    return `${opening}${joined} ${bracketGlyph(style.right, rows.length, rowIndex)}`;
  });
  return lines.join("\n");
}

const ENVIRONMENT_BOUNDARY = /\\(begin|end)\{([^}]*)\}/g;

/** Reads up to the `\end` that closes the environment just opened, returning its body. */
function readEnvironmentBody(cursor: Cursor): string {
  let depth = 1;
  for (const boundary of cursor.source.slice(cursor.index).matchAll(ENVIRONMENT_BOUNDARY)) {
    depth += boundary[1] === "begin" ? 1 : -1;
    if (depth === 0) {
      const start = cursor.index;
      const end = start + (boundary.index ?? 0);
      cursor.index = end + boundary[0].length;
      return cursor.source.slice(start, end);
    }
  }
  const rest = cursor.source.slice(cursor.index);
  cursor.index = cursor.source.length;
  return rest;
}

function currentLineWidth(output: string): number {
  return displayWidth(output.slice(output.lastIndexOf("\n") + 1));
}

/** Lines after the first sit under the first line's content, past whatever precedes it. */
function indentContinuation(layout: string, prefixWidth: number): string {
  if (prefixWidth === 0) {
    return layout;
  }
  return layout
    .split("\n")
    .map((line, lineIndex) => (lineIndex === 0 ? line : " ".repeat(prefixWidth) + line))
    .join("\n");
}

function readDelimiter(cursor: Cursor): string {
  skipWhitespace(cursor);
  if (cursor.source[cursor.index] === ".") {
    cursor.index += 1;
    return "";
  }
  return renderFragment(readArgument(cursor));
}

function renderScript(cursor: Cursor, glyphs: ReadonlyMap<string, string>, marker: string): string {
  const argument = readArgument(cursor);
  if (marker === "^" && argument === "\\circ") {
    return "°";
  }
  const rendered = renderFragment(argument).trim();
  if (rendered.length === 0) {
    return "";
  }
  if (marker === "^" && /^′+$/.test(rendered)) {
    return rendered;
  }
  return toScript(rendered, glyphs, marker);
}

function renderFraction(cursor: Cursor): string {
  const numerator = renderFragment(readArgument(cursor)).trim();
  const denominator = renderFragment(readArgument(cursor)).trim();
  return (
    VULGAR_FRACTIONS.get(`${numerator}/${denominator}`) ??
    `${group(numerator)}/${group(denominator)}`
  );
}

function renderRoot(cursor: Cursor): string {
  const index = readOptional(cursor);
  const radicand = renderFragment(readArgument(cursor)).trim();
  const root =
    index === undefined
      ? "√"
      : (ROOTS.get(index.trim()) ??
        `${toScript(renderFragment(index).trim(), SUPERSCRIPTS, "^")}√`);
  return `${root}${isSimpleRadicand(radicand) || isWrapped(radicand) ? radicand : `(${radicand})`}`;
}

function renderEnvironment(cursor: Cursor, output: string): string {
  skipWhitespace(cursor);
  const name = cursor.source[cursor.index] === "{" ? readGroup(cursor).trim() : "";
  const layout = layoutEnvironment(name, readEnvironmentBody(cursor));
  return indentContinuation(layout, currentLineWidth(output));
}

function renderCommand(cursor: Cursor, output: string): string {
  const name = readCommandName(cursor);
  if (name === "") {
    return "\\";
  }
  if (name === "\\") {
    OPTIONAL_LINE_SPACING.lastIndex = cursor.index;
    const spacing = OPTIONAL_LINE_SPACING.exec(cursor.source)?.[0];
    cursor.index += spacing?.length ?? 0;
    return "\n";
  }
  const symbol = SYMBOLS.get(name);
  if (symbol !== undefined) {
    return symbol;
  }
  if (OPERATOR_NAMES.has(name)) {
    return withTrailingSpace(cursor, `${/[\p{L}\p{N})]$/u.test(output) ? " " : ""}${name}`);
  }
  const spacing = SPACING.get(name);
  if (spacing !== undefined) {
    return spacing;
  }
  if (IGNORED.has(name)) {
    return "";
  }
  if (DISCARDED_ARGUMENT.has(name)) {
    readArgument(cursor);
    return "";
  }
  if (TRANSPARENT.has(name)) {
    return renderFragment(readArgument(cursor));
  }
  if (RAW_TEXT.has(name)) {
    return readArgument(cursor)
      .replace(/\\([{}%$&#_])/g, "$1")
      .replace(/~/g, " ");
  }
  if (DELIMITER_SIZING.has(name)) {
    return readDelimiter(cursor);
  }
  const alphabet = ALPHABETS.get(name);
  if (alphabet !== undefined) {
    return styleLetters(renderFragment(readArgument(cursor)), alphabet);
  }
  const accent = ACCENTS.get(name);
  if (accent !== undefined) {
    return applyAccent(renderFragment(readArgument(cursor)).trim(), name, accent);
  }
  switch (name) {
    case "frac":
    case "dfrac":
    case "tfrac":
    case "cfrac":
      return renderFraction(cursor);
    case "binom":
    case "dbinom":
    case "tbinom": {
      const top = renderFragment(readArgument(cursor)).trim();
      const bottom = renderFragment(readArgument(cursor)).trim();
      return `C(${top}, ${bottom})`;
    }
    case "sqrt":
      return renderRoot(cursor);
    case "operatorname": {
      if (cursor.source[cursor.index] === "*") {
        cursor.index += 1;
      }
      return withTrailingSpace(cursor, renderFragment(readArgument(cursor)));
    }
    case "not": {
      const negated = renderFragment(readArgument(cursor));
      return NEGATIONS.get(negated) ?? `${negated}\u0338`;
    }
    case "cancel":
    case "bcancel":
    case "xcancel":
      return [...renderFragment(readArgument(cursor))].map((glyph) => `${glyph}\u0338`).join("");
    case "boxed":
      return `[${renderFragment(readArgument(cursor)).trim()}]`;
    case "tag":
      return `  (${renderFragment(readArgument(cursor)).trim()})`;
    case "phantom":
    case "hphantom":
      return " ".repeat(displayWidth(renderFragment(readArgument(cursor))));
    case "hspace":
    case "hskip":
    case "kern":
      readArgument(cursor);
      return " ";
    case "pmod":
      return ` (mod ${renderFragment(readArgument(cursor)).trim()})`;
    case "textcolor":
    case "colorbox": {
      readArgument(cursor);
      return renderFragment(readArgument(cursor));
    }
    case "overset":
    case "stackrel":
    case "underset": {
      const annotation = renderFragment(readArgument(cursor)).trim();
      const base = renderFragment(readArgument(cursor)).trim();
      return name === "underset"
        ? `${base}${toScript(annotation, SUBSCRIPTS, "_")}`
        : `${base}${toScript(annotation, SUPERSCRIPTS, "^")}`;
    }
    case "substack":
      return splitRows(readArgument(cursor))
        .map((row) => renderFragment(row.join(" ")).trim())
        .join(", ");
    case "begin":
      return renderEnvironment(cursor, output);
    case "end":
      readArgument(cursor);
      return "";
    default: {
      if (cursor.source[cursor.index] === "{") {
        return `\\${name}{${renderFragment(readGroup(cursor))}}`;
      }
      return `\\${name}`;
    }
  }
}

function renderNext(cursor: Cursor, output: string): string {
  const character = cursor.source[cursor.index] ?? "";
  if (/\s/.test(character)) {
    skipWhitespace(cursor);
    return " ";
  }
  switch (character) {
    case "\\":
      cursor.index += 1;
      return renderCommand(cursor, output);
    case "{":
      return renderFragment(readGroup(cursor));
    case "^":
      cursor.index += 1;
      return renderScript(cursor, SUPERSCRIPTS, "^");
    case "_":
      cursor.index += 1;
      return renderScript(cursor, SUBSCRIPTS, "_");
    case "}":
    case "&":
    case "~":
      cursor.index += 1;
      return character === "}" ? "" : " ";
    case "-":
      cursor.index += 1;
      return "−";
    case "'":
      cursor.index += 1;
      return "′";
    default: {
      const single = String.fromCodePoint(cursor.source.codePointAt(cursor.index) ?? 0);
      cursor.index += single.length;
      return single;
    }
  }
}

function renderFragment(source: string): string {
  const cursor: Cursor = { source, index: 0 };
  let output = "";
  while (cursor.index < source.length) {
    const piece = renderNext(cursor, output);
    if (piece === " " && (output.length === 0 || /[ \n]$/.test(output))) {
      continue;
    }
    output += piece;
  }
  return output;
}

/**
 * The math source as Unicode text. A result with more than one line is a matrix, a case
 * split or an aligned block; its lines already carry the padding that lines them up.
 */
export function latexToUnicode(source: string): string {
  return renderFragment(source)
    .replace(/([⟨⌊⌈]) /g, "$1")
    .replace(/ ([⟩⌋⌉])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^\n+/, "")
    .trimEnd();
}
