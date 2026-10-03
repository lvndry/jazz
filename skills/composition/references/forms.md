# Forms & Capture

Compositions can be forms: a single-file, offline input→output artifact where
the person fills fields and the result renders **on the same screen, live** —
no backend, no submission, no "save" that goes anywhere. Use this when the
person asked for "a form", "a generator", "a builder", "a checklist that does
something", or wants to fill in data and get a result (document, summary,
config, comparison) back.

## The one rule that makes a composition form good

**The output is the product.** A web form ends in a submit button and a
spinner; a composition form ends in a _visible, live, correct result_. If the
form has no output panel (or the output is just "thanks, sent"), it is a web
form wearing a costume — make the result the dominant element, not the fields.

Decision order for any form composition:

1. What is the output (a document? a price? a comparison? a config file?) —
   design that first.
2. What fields produce it — as few as possible.
3. What states must not break it (empty, invalid, huge) — see states below.

## Shape picker

| Shape                | When                                                                  | Layout                                                                |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Inline strip**     | 2–4 controls that tweak a single view (the hyperinflation calculator) | Controls left/narrow, one big result right                            |
| **Side-by-side**     | Document builders, generators, profile cards                          | Fields 1/3, live preview 2/3; preview is the hero                     |
| **Wizard**           | 5+ fields or dependent questions (intake, onboarding, sizing)         | One step per screen, progress line, never more than ~5 fields visible |
| **Capture & export** | Checklists, trackers, briefs the person fills and keeps               | Form + an "Export" action (JSON/Markdown/copy)                        |

Wizards reuse the `slides` canvas (16:9, `go()` navigation, `#n` deep links) —
a multi-step form is a deck where each slide is a question and the last slide
is the generated result. This is the strongest shape for "Canva-style forms".

## Field rules

- **Native inputs, always** (`input`, `select`, `textarea`, `datalist`,
  `fieldset`+`legend`, real radios/checkboxes) — see `interactive` for styling
  and the segmented-control pattern. `datalist` is underrated: free
  autocomplete over a fixed list.
- **`autocomplete` on anything personal** (`name`, `email`, `tel`, `street`)
  — the browser does what a datalist can't.
- **Labels visible, not placeholder-only.** A placeholder disappears on focus
  and is not a label. `label for="id"`, always.
- **Defaults > empty.** Every field that can be pre-filled from context, URL
  params, or a sensible value should be. An all-empty form reads as broken.
- **Dependent fields hide or disable**, don't leave orphaned options
  ("No" → the "which one?" select disappears via the `@starting-style`
  pattern from `motion`).
- **One primary action per screen**, next to the output, not a fixed bottom
  bar. "Generate", "Copy", "Export" — the verb that names the result.

## Validation

Validate on `blur` and on the primary action, **never on first keystroke**.

```html
<label for="budget">Monthly budget</label>
<input
  id="budget"
  type="number"
  min="0"
  step="50"
  inputmode="decimal"
  aria-describedby="budget-err"
/>
<span
  id="budget-err"
  role="alert"
  hidden
  >Enter a number ≥ 0.</span
>
```

```css
input[aria-invalid="true"] {
  border-color: hsl(0 72% 60%);
}
[role="alert"] {
  color: hsl(0 72% 70%);
  font-size: 0.82rem;
  margin-top: var(--space-1);
}
```

- Message names the **fix**, not the error ("Enter a number ≥ 0", not "Invalid").
- Keep the user's text in the field. First invalid field gets focus on submit.
- Cross-field rules (dates: end ≥ start) validate both and say which.
- Hard-block only what breaks the output; everything else warns.

## State persistence (the offline save)

Compositions have no backend, so the persistence menu is:

1. **URL params** — shareable, free, survives refresh. Use for anything
   shareable ("send me the link with these answers"):

   ```js
   const params = new URLSearchParams(location.search);
   params.set("budget", budget.value);
   history.replaceState(null, "", `${location.pathname}?${params}`);
   ```

2. **`localStorage`** — private, survives close, good for trackers/checklists.
   Namespaced key: `composition.<title>.v1`. Always `try/catch` (file:// and
   private mode can throw).

3. **Export** — the real "submit": build the result as text and give the person
   a way out:

   ```js
   async function exportResult() {
     const blob = new Blob([markdown(result)], { type: "text/markdown" });
     const a = Object.assign(document.createElement("a"), {
       href: URL.createObjectURL(blob),
       download: "brief.md",
     });
     a.click();
     URL.revokeObjectURL(a.href);
   }
   // clipboard variant: navigator.clipboard.writeText(...) + a "Copied ✓" pulse
   ```

   Offer **copy** and/or **download** (.md, .json, .html, .ics) as buttons —
   a form the user can't get out of is a dead end.

4. **`<details>` draft autosave** for wizards: stash answers in the hash or
   localStorage per step so a refresh doesn't lose 4 steps of input.

## Result panel patterns

- **Document builder:** preview in a `<pre>`/`<article>` styled like the final
  doc; every keystroke re-renders (debounce text at 150ms). The preview IS the
  hero — fields are its sidebar.
- **Number/price:** `stat-value` + value pulse on change (`motion` reference);
  show the unit and a one-line explanation of how it was computed.
- **Comparison/plan:** cards side by side, the recommended one in
  `--accent-soft`, deltas labeled.
- **Config/code:** monospace block, copy button, language label.
- `aria-live="polite"` on the result container for screen readers.

## Wizard specifics

- Progress: the 3px accent line from `slides`, plus "Step X of N" in the
  counter slot.
- **Back must always work** and must preserve every answer (state lives in a
  JS object, inputs render from it — never read the DOM as the source of truth).
- Last slide: the generated result + export buttons + "edit answers" (jump
  back to a step, deep-linkable via `#step-n`).
- Validation gates forward, never back.

## Static mode

A form is inherently interactive, so static mode gets: the form **pre-filled
with representative values and the result already rendered** — a screenshot of
the form doing its job, not an empty shell. Keep entrance budget ≤800ms
(`motion`).

## Anti-patterns

- A form with no visible output — that's a web form, not a composition.
- Submitting anywhere (`fetch`, `<form action>`) — there is no server; the
  "server" is the result panel.
- Placeholder-as-label; floating labels that overlap on small screens.
- Alert/confirm for validation or "exported" — inline `role="alert"` + pulse.
- A 30-field flat form where a 3-step wizard was meant.
- Storing secrets in URL params (they're in the address bar and the file's
  title) — password fields get localStorage or export only.
- Re-rendering layout on keystroke: the result updates, the page does not move.
