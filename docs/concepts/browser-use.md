---
description: "Let an agent browse, read, and act on real web pages with the browser tools, and what the browser can and cannot reach."
---

# Browser Use

The browser tools let an agent open a page in a real headless Chrome, read it, and act on it:
follow links, fill forms, choose options, and sign in. Use them for pages that need JavaScript or
a session. For a single readable page, `web_fetch` is lighter.

The tools are off until you enable them for an agent. Run `jazz agent edit <agent>` and enable
**Browser** in the tool selection, or add the tool names to the agent's `config.tools`:

```json
{
  "tools": [
    "browser_navigate",
    "browser_back",
    "browser_snapshot",
    "browser_screenshot",
    "browser_act",
    "browser_close"
  ]
}
```

They load on demand: the agent finds them with `search_tools` when a task needs a real browser,
so enabling them adds nothing to a turn that never browses.

## How the agent uses it

```text
Open https://news.ycombinator.com, read the top five stories, and open the first
comment thread.
```

The agent calls `browser_navigate` to open a URL, then `browser_snapshot` to read the page. A
snapshot is a text outline of headings, text, and controls. Every link, button, field, and other
interactive element ends with a ref such as `[ref=e3]`:

```text
- heading "Sign in" [level=1]
- textbox "Email" [ref=e1]
- textbox "Password" [ref=e2]
- button "Continue" [ref=e3]
```

`browser_act` takes those refs to click, type, choose an option, or press a key. After the page
changes, the agent takes a new snapshot. `browser_screenshot` saves a PNG and returns its path,
which the agent passes to `analyze_media` when layout matters more than text.

| Tool                 | Risk        | What it does                                                         |
| -------------------- | ----------- | -------------------------------------------------------------------- |
| `browser_navigate`   | `low-risk`  | Open an http(s) URL.                                                 |
| `browser_back`       | `low-risk`  | Go back one page.                                                    |
| `browser_snapshot`   | `read-only` | Read the page as a text outline with refs.                           |
| `browser_screenshot` | `low-risk`  | Save a PNG of the page and return its path.                          |
| `browser_act`        | `high-risk` | Click, type, choose an option, or press a key. Gated by approval.    |
| `browser_close`      | `read-only` | Close the browser and discard its cookies. The next call reopens it. |

Clicking and typing can submit a form, so `browser_act` is gated like `write_file`. In an
unattended run it parks for approval instead of acting. See [Approvals](../security/approvals.md).

## Signing in

Collect the password with `ask_user_secret`. The agent receives a placeholder, passes it as the
`text` of a `browser_act` type action, and Jazz substitutes the value only after you approve.
The approval names the page, and Jazz enters the secret only on an `https` page or one served
from this machine.

## Which browser

Jazz drives a browser in this order, with no setup required:

1. **A browser you run on the local DevTools port** (`http://127.0.0.1:9222` by default).
   Start Chrome with `--remote-debugging-port=9222` and the agent drives it: headed, with your
   profile, and able to adopt tabs you already have open via `browser_adopt_tab`.
2. **A launched Chrome or Chromium**, the same one compositions use, when nothing listens on
   the port. Set `PUPPETEER_EXECUTABLE_PATH` to use a specific binary. The browser starts on
   the first call, uses a fresh temporary profile, and is closed, with the profile deleted,
   when the run ends. A run has one tab, and pop-ups are refused.
3. **A configured endpoint**: `network.browserEndpoint` in your global config points the
   browser tools at any running browser that speaks the Chrome DevTools Protocol, `http(s)://`
   or `ws(s)://`. Jazz opens an isolated context in it instead of launching Chrome. Everything
   the agent reads and types then reaches that browser's host, so point it only at a browser
   you control.

For example, [Lightpanda](https://lightpanda.io) is a lightweight browser that starts in
milliseconds. Run `lightpanda serve --host 127.0.0.1 --port 9222`, then set:

```json
{ "network": { "browserEndpoint": "ws://127.0.0.1:9222" } }
```

Reading pages, typing, choosing options, and clicking work there. A browser without a full
layout engine clicks through the element itself, and pages that depend on rendering or
anti-bot checks may behave differently from Chrome.

## Flagged pages

Some pages deserve a second look before the agent types into them. Jazz flags a page when its own
structure shows a password field or payment card fields. A flagged page changes two things:

- `browser_snapshot` opens with a warning line, such as "Warning: this page has a password field."
- `browser_act` asks you on every call there, even under the `high-risk` policy or an allowlist,
  and the approval repeats the warning.

A flag only adds scrutiny. Nothing lowers a risk, skips an approval, or clears the
untrusted-content marking. Fields inside a frame from another site are not seen by this check.

An enabled plugin can add flags, for a page that may be a human check or whose labels address an AI
agent, and can reorder a snapshot so the elements relevant to your request come first under
"Likely relevant to your request:". It cannot hide an element: the whole outline follows. Both
hooks are advisory, time-limited, and fall back to the plain behavior on any error or abstention.
See [Browser page hooks](../configure/plugins.md#browser-page-hooks).

## What the page can reach

Every request a page makes, including images, scripts, and redirects, is held to the same rules
as `web_fetch` and `read_pdf`: public addresses only, unless the host is in
`network.allowPrivateHosts`. A page cannot reach `localhost`, your local network, or the cloud
metadata address through its own scripts. With a URL list in `network.httpApproval`, the browser
loads only matching URLs and the origins of pages it opened from them. `file:` URLs are refused.

What a page shows the agent is another party's text. It arrives inside the `untrusted-content`
envelope and marks the run as having read external content, so outbound tools stop auto-approving
afterwards. See [Browser safety](../security/secrets-and-egress.md#browser-safety) for what the
isolation does and does not cover.

## Limits

- One snapshot call shows at most 24,000 characters. A longer page ends with a note naming the
  `startLine` that continues it, and refs stay valid across those calls. The outline of a whole
  page stops at 240,000 characters.
- One page action waits at most 15 seconds, and a navigation 30 seconds.
- Downloads are disabled where the browser supports it, and there are no file uploads.
- WebSocket and WebRTC traffic from a page is not covered by the request rules above.

## Related

- [Browser safety](../security/secrets-and-egress.md#browser-safety): what the browser can and cannot reach
- [Tool inventory](../tools/index.md#browser): the risk tier and disclosure of each tool
- [Model companions](./media.md): `analyze_media` for reading screenshots
- [Compositions](./compositions.md): the other feature that renders pages in Chrome
