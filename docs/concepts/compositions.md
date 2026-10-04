---
description: "Create charts, dashboards, calculators, and interactive HTML pages with Jazz compositions, then open or share the saved files."
---

# Compositions

A composition is an HTML page Jazz creates for you: a chart, dashboard, calculator,
planner, or interactive explanation. You can open the page in a browser or ask for a
static PNG to share.

Use one when you need to explore data, change inputs, or keep a visual result.

## Enable compositions

Run `jazz agent edit <agent>` and enable **Compositions** in the tool selection.
You can also add `create_composition` to the agent's `config.tools` list:

```json
{
  "tools": ["create_composition"]
}
```

The tool needs low-risk approval. The bundled `composition` skill gives the agent
instructions for designing the page.

## Ask for a composition

Give Jazz the data and describe what you want to see or change:

```text
Create an interactive composition from spending.csv. Show monthly spending by
category, with filters for month and category.
```

For a static image, say so and include the size if it matters:

```text
Create a static composition showing weekly signups from signups.csv.
Use a bar chart with labeled values, 1200 pixels wide and 600 pixels tall.
```

To revise it, ask in the same conversation:

```text
Add a comparison with the previous month and show the percentage change.
```

New compositions keep earlier files. Reusing a title adds a numbered suffix, such as
`monthly-spending-2.html`.

## Interactive pages and static images

| Mode        | What you get                                               | Requirements                                   |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Interactive | An HTML page with controls, filters, or other interactions | A browser to open the result                   |
| Static      | The HTML page plus a PNG screenshot                        | Chrome or Chromium on the machine running Jazz |

Static rendering uses an 800 × 600 pixel viewport by default. You can request each
dimension from 200 to 2000 pixels; the screenshot includes the full page. If Jazz cannot
find Chrome, set `PUPPETEER_EXECUTABLE_PATH` to your browser executable or ask for an
interactive composition instead.

## Open and share the result

Files are saved under `$JAZZ_HOME/compositions/<session-id>/`, normally
`~/.jazz/compositions/<session-id>/`. Jazz reports the paths and opens the HTML page
automatically in an interactive local terminal. Scripts and remote runs return the paths
without opening a browser.

- **HTML:** open the file in your browser or share it as a file. A self-contained page
  needs no app server; external libraries or APIs still need network access.
- **PNG:** share it as an image. Its labels and values are rendered from the HTML.
- **Headless runs:** `jazz run --json` includes the files in `artifacts` and composition
  details such as `htmlPath` and, for static mode, `imagePath`.
- **Telegram and Discord:** static compositions are sent as images. Interactive links
  require a public HTTPS origin configured on the bridge: `TELEGRAM_WEBAPP_BASE_URL` or
  `DISCORD_PUBLIC_BASE_URL`. See [Chat platforms](../surfaces/chat.md).

Compositions can contain JavaScript. Only open pages you trust, and keep secrets out of
files or links you share.

## Publish a composition to a URL

`publish_composition` takes an interactive composition and makes it available at a
stable public or private URL, so it can be shared without sending the file.

The agent always asks **public or private** first, and the answer decides the whole
deploy path:

- **Public** — you pick the host: GitHub Pages (default) or Cloudflare Pages.
  The page is cloned into your `<you>/compositions` repo and served at
  `<you>.github.io/compositions/<slug>.html` (or `compositions.pages.dev/…`).
- **Private** — always Cloudflare Pages, from a **private** repo
  (`<you>/compositions-private`). The source file stays in a private repository,
  and the page itself is locked behind
  [Cloudflare Access](https://one.dash.cloudflare.com/): anyone who opens the URL
  gets a sign-in screen that sends a one-time PIN to the configured email. No
  account on the visitor's side is needed.

First use creates the repo, the Pages project, and the Access app automatically;
re-publishing an existing slug redeploys in place.

### Requirements

- `gh` authenticated and `git` on PATH (both hosts need the GitHub step).
- For Cloudflare (private publishing, or public-on-Cloudflare):
  `~/.config/jazz/cloudflare.json`

  ```json
  { "schemaVersion": 1, "token": "…", "accountId": "…", "accessEmail": "you@email.com" }
  ```

  The token needs **Cloudflare Pages: Edit** and **Access: Apps: Edit** permissions
  (a scoped token from the dashboard is enough). `accessEmail` controls who can open
  private pages. One-time setup: open
  [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) and click **Enable
  Access** if the account has never used Access.

### Managing the private allow list

Publishing creates an Access app whose allow rule admits exactly `accessEmail` —
with `you@email.com`, only that address gets in. To let more people in, open the
Cloudflare One dashboard → **Access → Applications** → the app named
`jazz-<project>` → **Policies** → edit, and add more **Email address** include
rules. The tool never rewrites an existing app on re-publish, so manual changes
are preserved.

## Related

- [Artifacts](./artifacts.md): where generated files are saved and how surfaces present them
- [Model companions](./media.md): generating images, audio, and video with specialist models
- [Composition tools](../tools/index.md#compositions): tool reference and PDF rendering
