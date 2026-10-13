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

The agent supplies the page either as the `html` argument or as `htmlPath`, a
file it writes and edits on disk first. For large or iterated pages it uses
`htmlPath`, so revisions are file edits plus a short re-call instead of
re-sending the whole document.

## Visual design

Compositions have no mandatory house style. Jazz chooses typography, colors,
layout, and motion for the content and audience, following your references or
existing product design when provided.

The composition skill links directly to [Refero Styles](https://styles.refero.design/)
for design directions, [21st.dev](https://21st.dev/community/components) for
component ideas, [Component Gallery](https://component.gallery/) for design-system
examples, [Kinetics](https://kinetics.colorion.co/) for motion, and
[Impeccable](https://impeccable.style/) for design guidance. The agent uses sources
that help the task rather than following a fixed research pipeline. Browsing
depends on the agent's available tools; a composition can still be created offline.

You can name a source or describe the direction you want:

```text
Create a spending report with an editorial layout and expressive typography.
Use Refero for inspiration and Component Gallery for the filter controls.
```

The design guidance still requires readable data, accessible controls, responsive
layout, and working interactions, including keyboard navigation for slide decks.
The skill calls for checking inline JavaScript with `node --check`, independently
of browser access, and reporting when that check cannot be run. When a browser is
available, it also calls for checking the rendered page and controls before delivery.

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
  The page lands in your `<you>/compositions` repo and is served at
  `<you>.github.io/compositions/compositions/<slug>/` (or `/compositions/<slug>/` on the
  Cloudflare host).
- **Private** — always Cloudflare Pages, from a **private** repo
  (`<you>/compositions-private`). The source file stays in a private repository
  at `compositions/private/<slug>/`, and the page itself is locked behind
  [Cloudflare Access](https://one.dash.cloudflare.com/): anyone who opens the URL
  gets a sign-in screen that sends a one-time code to an allowed email. No
  Cloudflare account is needed on the visitor's side — the free "Cloudflare
  Access" provider signs people in with just an email address.

When the rendering fonts are available, published pages include a **Jazz-styled
`og.png` card** plus `og:title`/`og:image` metadata. Card rendering is optional;
a missing font stack does not prevent publishing.

First use creates the repo, the Pages project, and the Access applications automatically.
The tool verifies repository visibility before cloning or pushing. A private request
refuses a public repository, including a repository passed through `repo`.

Cloudflare publishing uploads the complete `compositions/` directory from the checkout,
so adding a new slug retains existing pages. A deployment failure returns an error;
a Git integration is not required and is not used as a fallback. Re-publishing an
existing slug replaces that page in the next snapshot.

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
  Access** if the account has never used Access. Enable **One-time PIN** under
  **Integrations → Identity providers** for email-code sign-in.

- `accessEmail` is required for private publishing. Optional `pagesHost` must already
  be attached to that Pages project; the tool does not register a custom domain.
  Without it, links use Cloudflare's assigned subdomain, which may include a suffix.

### Managing the private allow list

Private publishing creates email allow policies for the assigned Pages hostname,
its `*.<assigned-hostname>` deployment aliases, and every attached custom domain.
These gates are configured and verified before source is pushed or assets are uploaded.
A configured custom `pagesHost` protects `/compositions/private`; other project
hostnames are protected in full.

Manage access in Cloudflare One → **Access → Applications** → the applications
named `jazz-<project>-<number>` → **Policies**. Update every application protecting
the project when adding or removing an allowed address. Compatible existing email
and email-domain allow lists are preserved. Publishing refuses applicable bypass
policies, public destination overrides, and allow rules whose email restriction it
cannot verify. An Access configuration failure stops publication before any content
is pushed or uploaded.

## Related

- [Artifacts](./artifacts.md): where generated files are saved and how surfaces present them
- [Model companions](./media.md): generating images, audio, and video with specialist models
- [Composition tools](../tools/index.md#compositions): tool reference and PDF rendering
