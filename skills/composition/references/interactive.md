# Interactive

Patterns for controls, overlays, and state changes in interactive-mode
compositions. Principles: real native elements with real semantics, state that
is visible without color alone, and a result the person understands without a
manual.

## Native elements first

| Job                      | Element                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| Open/close a section     | `button` + `aria-expanded` + `@starting-style` panel (motion ref) |
| A side panel or menu     | `<dialog>` (modal) or `popover` attribute (non-modal)             |
| A choice from ≤4 options | `radiogroup` of real radios styled as segmented buttons           |
| On/off                   | `input[type=checkbox]` styled as a toggle                         |
| A number                 | `input[type=range]` for explore, `input[type=number]` for precise |
| A date                   | `input[type=date]` — don't build a calendar                       |

Never recreate a native control with `div`s. Style them, but keep the element,
`label`, and native keyboard behavior.

## Focus and keyboard

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```

- Logical tab order follows the visual order; don't reach for `tabindex` above
  0 — restructure the DOM instead.
- Every icon-only control gets `aria-label` (and a visible tooltip or caption
  where the meaning isn't obvious).
- `Escape` closes dialog/popover for free; test that the page is still usable
  with the mouse unplugged.

## Popover (non-modal: pickers, menus, detail)

```html
<button
  popovertarget="detail"
  aria-haspopup="popover"
>
  Details
</button>
<div
  id="detail"
  popover
>
  <p>…</p>
</div>
```

```css
[popover] {
  margin: auto;
  background: var(--surface-2);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  padding: var(--space-3);
  opacity: 0;
  transform: translateY(4px) scale(0.98);
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
[popover]:open {
  opacity: 1;
  transform: none;
}
/* :popover-open is not supported everywhere; @starting-style is the
   cross-browser way to animate the enter */
@starting-style {
  [popover]:open {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }
}
```

Outside click and `Escape` come free. For anchored placement,
`anchor-name`/`position-absolute: anchored()` where supported, otherwise
position it manually near the trigger.

## Dialog (modal: confirm, focus task)

```html
<dialog id="confirm">
  <h2>Reset all values?</h2>
  <p>Sub-copy</p>
  <menu>
    <button value="cancel">Cancel</button>
    <button
      value="ok"
      class="primary"
    >
      Reset
    </button>
  </menu>
</dialog>
```

```js
const ok = await new Promise((resolve) => {
  const d = document.getElementById("confirm");
  d.onclose = () => resolve(d.returnValue === "ok");
  d.showModal();
});
```

`::backdrop { background: hsl(0 0% 0% / 0.5); }` for a calm dim. Focus is
managed natively — don't fight it.

## Segmented control

```html
<fieldset
  class="segmented"
  role="radiogroup"
  aria-label="Time range"
>
  <label
    ><input
      type="radio"
      name="range"
      value="w"
    /><span>Week</span></label
  >
  <label
    ><input
      type="radio"
      name="range"
      value="m"
      checked
    /><span>Month</span></label
  >
  <label
    ><input
      type="radio"
      name="range"
      value="y"
    /><span>Year</span></label
  >
</fieldset>
```

```css
.segmented {
  display: inline-flex;
  gap: 2px;
  border: none;
  padding: 2px;
  background: var(--surface-2);
  border-radius: 999px;
}
.segmented label {
  position: relative;
}
.segmented input {
  position: absolute;
  opacity: 0;
  inset: 0;
}
.segmented span {
  display: block;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--ink-muted);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
  cursor: pointer;
}
.segmented input:checked + span {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.segmented input:focus-visible + span {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

The radios stay the source of truth; JS reads `.checked` and re-renders.

## :has() — component state from descendants

```css
/* form card glows when any field has content (dirty) */
.card:has(input:not(:placeholder-shown), select:invalid) {
  border-color: var(--accent);
}
/* row highlights while its own control is focused */
.row:has(input:focus-visible) {
  background: var(--accent-soft);
}
```

No JS for these; `:has()` is baseline in current browsers.

## Live updates

- Wrap changing values in a container with `aria-live="polite"` so screen
  readers announce the new number.
- Debounce text inputs (~150ms); ranges and radios update immediately.
- After every state change: update the _primary_ view first (the chart/result),
  secondary detail after. The answer must never wait on cosmetics.
- Value pulse (motion ref) on any number that changed as a result of user
  input.
- Persist interesting state in `URLSearchParams` so the page reopens where the
  person left off — free shareability, ~10 lines.

```js
const params = new URLSearchParams(location.search);
function save(key, value) {
  params.set(key, value);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}
```

## Buttons

```css
button {
  font: inherit;
  cursor: pointer;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink);
  padding: 8px 16px;
  font-weight: 500;
  transition:
    transform var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
button:hover {
  transform: translateY(-1px);
}
button:active {
  transform: none;
}
button.primary {
  background: var(--accent);
  border-color: transparent;
  color: hsl(var(--accent-h) var(--accent-s) 12%);
  font-weight: 600;
}
button.primary:hover {
  background: var(--accent-strong);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
  transform: none;
}
```

One `.primary` per screen. The primary button sits next to what it acts on,
bottom-right for a form, never floating far from its context.

## Empty, loading, error states

Design them before they happen:

- **Empty:** a short line ("No data yet") + the action that fills it. Not a
  blank card.
- **Loading:** skeleton blocks (`--surface-2` + a subtle opacity pulse), never
  a spinner over content.
- **Invalid input:** `aria-invalid` + a message that names the fix; keep the
  user's text in the field.
- If a CDN script fails (interactive mode has network; static mode may not),
  guard: `if (window.Chart) { … } else { showFallback(); }` where the
  fallback is a static table or plain SVG.

## Anti-patterns

- `alert()`/`confirm()` — use a dialog.
- Modals stacked on modals.
- A control that changes data with no visible result somewhere on screen.
- Auto-updating before the user's input settles.
- Keyboard shortcuts without a discoverable hint in the UI.
- Animating a re-layout on every keystroke — the chart should update, the page
  should not move.
