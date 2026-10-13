# Form mechanics

Use this reference for compositions that turn inputs into a live result, such
as calculators, builders, generators, and trackers. Choose the visual design
using the composition skill; this reference covers behavior only.

## Inputs and results

Design the output first, then include the fields needed to produce it. Show a
useful result from sensible initial values. Keep the output visible as inputs
change; debounce expensive text-driven updates, but respond promptly to sliders
and selections. Announce meaningful result changes with `aria-live="polite"`
without reading an entire document back on every keystroke.

Use native inputs, visible labels, appropriate input types, and autocomplete
where relevant. Hide or disable irrelevant dependent fields. Validate on blur
or the action that needs a valid result, retaining the person's input and
explaining how to fix it. Associate messages with fields using
`aria-describedby` and mark invalid fields with `aria-invalid`.

For multi-step forms, keep answers in explicit state. Back navigation preserves
answers; validation gates forward navigation only. Show the current step and
allow answers to be reviewed and edited before export. Choose a responsive
layout for the form rather than forcing it into a presentation canvas.

## Persistence and export

A standalone form has no submission endpoint unless a backend was explicitly
requested. Make the result usable through copy or download when appropriate.

- URL parameters can retain non-sensitive, shareable inputs. Parse and validate
  them before using them as state.
- `localStorage` can retain non-sensitive drafts on the same browser. Namespace
  keys per composition and handle unavailable storage without breaking the form.
- Copy/download actions should export the current result and show whether the
  action succeeded. Revoke temporary object URLs after downloads.
- Keep secrets out of URLs, browser storage, and exported artifacts. Render
  user-supplied text as text, rather than interpolating it into HTML.

## Verification

Exercise empty, invalid, large, and boundary inputs, dependent fields, back
navigation, reload, and export. Check the result against the underlying
calculation or transformation, not just whether the controls move.

A static preview needs representative inputs and an already-rendered result;
label illustrative values and use no entrance animation that delays the output.
