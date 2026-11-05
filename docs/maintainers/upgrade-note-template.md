---
description: "Template and rules for the upgrade note every Jazz pull request that breaks a working setup adds under docs/upgrading, including the migration table."
---

# Upgrade notes for breaking changes

A change is breaking when it makes a working setup fail or behave less permissively: a renamed or
removed config key, flag or envelope field, or a default that now grants less. The definition is the
one in [Upgrading Jazz](../upgrading.md#versioning-policy).

Every pull request that makes such a change adds one note to
[`docs/upgrading/`](../upgrading.md#migration-notes) in the same PR, and adds a line to the list in
that section. A reviewer should block a `!` PR (`feat(scope)!:`) that has no note. The note is short:
a reader with a failing setup finds the old name, the new name and the action, then leaves.

Copy the block below to `docs/upgrading/<short-slug>.md`. Write counts and limits as numerals.

```markdown
---
description: "One sentence naming what stopped working and what to change, 50 to 320 characters."
---

# Short title naming the change

First release: `0.X.0` (the minor that ships this PR). PR: #NNN.

## What changes

One or 2 sentences: the behavior before, the behavior after, and why.

## Migration

| Before | After | Applies to | Action |
| ------ | ----- | ---------- | ------ |
| `old.key` | `new.key` | `~/.jazz/config.json` | Rename the key, then run `jazz config validate` |

Name every renamed or removed key, flag, field, default or command in its own row. A removed item
has `removed` in the After column and the replacement, if any, in Action.

## What you see if you do nothing

The exact error, refusal or changed behavior, so a reader can search for it.
```

Rules for the table:

- No alias or compatibility shim stands in for the old name; the table is the migration path.
- Every row names a command or an edit the reader can run, not "update your config".
- A default that now grants less gets a row whose Action is the explicit opt-in to restore it.
