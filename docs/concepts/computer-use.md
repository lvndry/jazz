---
description: "Experimental: let an agent look at and act in desktop apps you grant on your Mac, while you watch. What to set up, what each app allows, and what it can and cannot reach."
---

# Computer use

> **Experimental.** Computer use may change or break between releases. It runs on macOS with
> Apple Silicon only, and only in a terminal conversation while you watch. Screenshots and
> on-screen text are sent to your model provider, and nothing here is an operating-system
> sandbox: Jazz limits what the agent does, not what an app can do.

Computer use lets an agent read the windows of desktop apps you choose and click, scroll, and
type in them, without taking over your cursor. Use it for work that only a desktop app can do.
For web pages, the [browser tools](./browser-use.md) is the better tool.

## Set it up

Computer use needs a desktop driver, `cua-driver`, installed on your Mac. Jazz finds it on your
`PATH`, or at the path in `JAZZ_COMPUTER_DRIVER`. The driver needs two macOS permissions,
Accessibility and Screen Recording, granted to it in System Settings under Privacy & Security.

1. Check the machine and the driver:

   ```bash
   jazz computer doctor
   ```

   It exits 0 when ready, 1 when something needs attention, and 2 when computer use cannot run
   here. It names the permission to grant when the driver cannot read the desktop.

2. Acknowledge what computer use does. Jazz records the driver build you trust, and refuses to
   run a driver that changes afterwards until you acknowledge it again:

   ```bash
   jazz computer acknowledge
   ```

3. Find an app's bundle id, then grant it for a limited time:

   ```bash
   jazz computer apps
   jazz computer grant com.apple.Notes --expires 2h
   ```

4. Turn the tools on for an agent. Run `jazz agent edit <agent>` and enable **Computer use
   (experimental)**, or add the tool names to the agent's `config.tools`:

   ```json
   {
     "tools": [
       "computer_apps",
       "computer_observe",
       "computer_pointer",
       "computer_input",
       "computer_foreground",
       "computer_handoff",
       "computer_end"
     ]
   }
   ```

The tools load on demand, so enabling them adds nothing to a turn that never uses the desktop.
Only you can acknowledge and grant: those commands refuse to run inside a process an agent
started, and the agent has no tool that grants.

## How the agent uses it

```text
In Notes, open the note called Shopping and add "oat milk" to the list.
```

The agent calls `computer_apps` to see what it may control, then `computer_observe` to read a
window. An observation is a text outline of the window's controls. Each control it may act on
ends with a ref such as `[ref=c3.12]`, and the outline names its observation, such as `c3`:

```text
observation: c3
app: Notes (com.apple.Notes)
window: "Shopping"
access: full control
elements: 14

- AXToolbar
  - AXButton "New Note" [ref=c3.4]
- AXTextArea "Note body" [ref=c3.9]
```

`computer_pointer` clicks a ref, clicks a pixel of the observation's screenshot, or scrolls.
`computer_input` types into a ref or presses a named key or shortcut. After the window changes,
the agent observes again. A new observation retires the refs of the earlier one, and acting
through a retired ref is an error, not a click on whatever moved into its place.

`computer_observe` with `screenshot` saves a PNG of the window and returns its path. The agent
passes the path to `analyze_media`, so a model that cannot see images can still use it. Jazz
keeps the latest five screenshots and deletes them all when the run ends.

| Tool                  | Risk        | What it does                                                          |
| --------------------- | ----------- | --------------------------------------------------------------------- |
| `computer_apps`       | `read-only` | List the granted apps, what each allows, and their windows.           |
| `computer_observe`    | `read-only` | Read one window as an outline with refs, and optionally a screenshot. |
| `computer_pointer`    | `low-risk`  | Click or scroll in the background.                                    |
| `computer_input`      | `high-risk` | Type text or press a named key or shortcut.                           |
| `computer_foreground` | `high-risk` | Bring the app to the front, then act. Needs a foreground grant.       |
| `computer_handoff`    | `low-risk`  | Pause and ask you to do a step yourself. Always asks.                 |
| `computer_end`        | `read-only` | Stop, delete the screenshots, and release the desktop.                |

See the [tool inventory](../tools/index.md#computer-use-experimental) for disclosure and approval
pairs.

## What each app allows

Jazz decides how much an agent may do in an app from its bundle id. You cannot raise it.

| Class        | What the agent may do                       | Examples                                                      |
| ------------ | ------------------------------------------- | ------------------------------------------------------------- |
| `refused`    | Nothing. No grant is possible.              | Terminals, password managers, System Settings, script editors |
| `view-only`  | Read the window.                            | Browsers                                                      |
| `click-only` | Read, click, and scroll. No typing or keys. | Editors, IDEs, Finder                                         |
| `full`       | Everything the tools offer.                 | Every other app                                               |

Terminals are refused because controlling one would bypass the shell tool's approvals, denylist,
and secret redaction. An app whose bundle id Jazz cannot read is refused. A view-only window is
observed without refs, so there is nothing in it to click.

## Signing in

The agent never types a password it made up. Two things keep credentials out of its hands:

- A password field accepts only a secret you collected with `ask_user_secret`. The agent passes
  the placeholder as the text, Jazz asks you before entering it, and the model only ever sees
  the placeholder.
- For anything else, the agent calls `computer_handoff` with what you should do, such as
  signing in. Computer use pauses until you approve, nothing is read or acted on while you work,
  and every earlier observation is cleared afterwards.

## Approvals

Reading a window is automatic once you grant the app. Everything the agent reads from a window
is another party's text: it arrives inside the `untrusted-content` envelope and marks the run as
having read external content. After that, other outbound tools stop auto-approving below the
`high-risk` policy, so in the default safe mode expect a prompt for each action the agent takes
after its first look. `computer_input` and `computer_foreground` always need approval unless the
policy is `high-risk`.

Some actions are never taken, whatever the approval: the shortcuts that empty the Trash, lock
the screen, or log out; text that downloads and runs code or deletes data; and key presses that
would type a character, which go through `computer_input` so its checks apply.

## Stopping

- `jazz computer stop` ends the run that is using the computer. It takes effect at the agent's
  next action and stops the driver at once, and the run cannot use the computer again.
- `jazz computer revoke <bundle-id>` takes an app away, effective on the very next action.
- A grant expires after the time you gave it, at most seven days. A run that sits idle past the
  shortest idle timeout among its grants, 30 minutes by default, loses access for good.
- Only one run uses the computer at a time. A second is told who holds it, and a run that
  crashed leaves nothing locked.
- Jazz shows a desktop notification when a run starts using the computer and when it finishes,
  where your terminal or system can show one.

## What Jazz records

`jazz computer log` shows what computer use did: the app, the action, the element or window,
and how it turned out. The record never holds a screenshot or typed text. An element's or
window's label is shortened and has secrets redacted. It is stored in `$JAZZ_HOME/computer/ledger.jsonl`.

## Limits

- Computer use is withheld from every run nobody is watching: scripts, schedules, goals, loops,
  webhooks, peers, bots, and detached jobs. The tools are simply absent. A sub-agent never gets them either.
- It runs on macOS with Apple Silicon only.
- Acting in the background works through the driver and differs between apps. Apps that draw
  their own content, such as design tools and games, may need the foreground tool, which brings
  the app to the front and needs `--foreground` on its grant.
- Screenshots and on-screen text reach your model provider. Keep apps you do not want it to see
  out of the grant, and close their windows.
- The [security model](../security/secrets-and-egress.md#computer-use-safety-experimental)
  lists what this does not protect against.

## Related

- [Computer use safety](../security/secrets-and-egress.md#computer-use-safety-experimental): what the desktop tools can and cannot reach
- [`jazz computer`](../commands.md#jazz-computer): the operator commands
- [Browser tools](./browser-use.md): reading and acting on web pages
- [Model companions](./media.md): `analyze_media` for reading screenshots
