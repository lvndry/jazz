# HTML presentation mechanics

Use this reference when the person wants an HTML deck to present or navigate.
Choose the deck's visual design using the composition skill; this reference
covers navigation and output behavior only.

## Structure

Give each slide a clear idea and a visual or evidence that supports it. Keep
sources and units with the data they describe. Maintain a consistent design
across the deck, adapting layouts to each slide's content.

Use semantic sections and explicit current-slide state. A presentation can use
a fixed aspect ratio when appropriate, but text and controls must remain
readable on smaller screens and at zoom. Allow a reading layout when scaling
the canvas would make the content illegible.

## Navigation

Provide visible previous/next controls and a current-slide count. Keyboard
navigation can support arrows, Page Up/Down, Home, and End; don't intercept
keystrokes inside inputs, editable content, or an open dialog. Keep navigation
manual unless the person explicitly requests autoplay.

Hide inactive slides from display and the accessibility tree. If navigation
hides the focused element, move focus to an appropriate visible control or
slide heading. Announce slide changes briefly. Optional speaker notes should
be discoverable and closed initially.

Use a validated slide number in the URL hash for deep links. Initialize the
first slide even when navigation would otherwise be a no-op; reject or clamp
out-of-range hashes. Keep slide state, controls, counter, and URL synchronized.

Motion is optional. Honor reduced motion and provide an immediate transition
when an animation API is unavailable.

## Print and static output

A print stylesheet should show all slides in order, give each its own page,
and hide navigation and notes. Remove fixed positioning, visibility rules,
transforms, and animations that would hide or clip printed content.

Static mode renders the displayed HTML state, not a multi-page deck export.
Show a useful initial slide fully rendered without entrance delays, and explain
that the PNG is a preview. Verify first/last boundaries, keyboard navigation,
deep links, narrow screens, and print layout before delivery.
