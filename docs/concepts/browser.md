---
description: "Let an agent browse, read, and act on real web pages with the browser tools, and what the browser can and cannot reach."
---

# Browser

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

Jazz launches the Chrome or Chromium it finds on the machine, the same one compositions use. Set
`PUPPETEER_EXECUTABLE_PATH` to use a specific binary. The browser starts on the first call, uses
a fresh temporary profile, and is closed, with the profile deleted, when the run ends. A run has
one tab, and pop-ups are refused.

To drive a browser that is already running, such as a remote or alternative engine that speaks
the Chrome DevTools Protocol, set `network.browserEndpoint` in your global config to its
`http(s)://` or `ws(s)://` URL. Jazz opens an isolated context in it instead of launching Chrome.
Everything the agent reads and types then reaches that browser's host, so point it only at a
browser you control.

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

- The snapshot is capped at 24,000 characters. A long page ends with a line saying so; scroll
  with a `PageDown` key press and snapshot again.
- One page action waits at most 15 seconds, and a navigation 30 seconds.
- Downloads are disabled where the browser supports it, and there are no file uploads.
- WebSocket and WebRTC traffic from a page is not covered by the request rules above.

## Related

- [Browser safety](../security/secrets-and-egress.md#browser-safety): what the browser can and cannot reach
- [Tool inventory](../tools/index.md#browser): the risk tier and disclosure of each tool
- [Model companions](./media.md): `analyze_media` for reading screenshots
- [Compositions](./compositions.md): the other feature that renders pages in Chrome
