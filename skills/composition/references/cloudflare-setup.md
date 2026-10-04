# Private publishing: Cloudflare setup & the manual steps

Private compositions are served by Cloudflare Pages from a **private** GitHub
repo, behind a **Cloudflare Access** sign-in. Most of it is automatic; a small
number of things live in the Cloudflare dashboard because they are OAuth or
account-level actions the API cannot do. This reference is the runbook. Read
it when a private publish fails, a published URL 500s, or the person wants to
change who can open a private page.

## What is automatic vs manual

| Step                                       | Where                         | When                  |
| ------------------------------------------ | ----------------------------- | --------------------- |
| Create the private repo                    | `gh`, automatic               | first private publish |
| Create the Pages project                   | Cloudflare API, automatic     | first private publish |
| Create the Access app + allow policy       | Cloudflare API, automatic     | first private publish |
| **Enable the Access service**              | **Cloudflare One dashboard**  | **once, per account** |
| **Connect the project to the GitHub repo** | **Workers & Pages dashboard** | **once, per project** |
| **Add / remove allowed emails**            | **Cloudflare One dashboard**  | **any time**          |

Everything else — pushing the file, deploying, re-publishing — is what the
tool does.

## 1 · Enable the Access service (once per account)

Open [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) — this is the
**Cloudflare One / Zero Trust portal, not the main dashboard** — and click
**Enable Access**. Free and one-time. Without it, Access-app creation fails
with `access.api.error.not_enabled`, and the tool tells you exactly that.

## 2 · Connect the project to the GitHub repo (once per project)

**Why it exists:** direct-upload deploys (the asset API the tool uses) report
success but the edge then **500s** on some accounts. The reliable path is a
git-integrated project: the tool pushes the file to the private repo, and for
a git project that push _is_ the deploy. Git integration is an OAuth
authorization of Cloudflare's GitHub app, so it must be done in the browser —
`wrangler pages project create` has no git flag, and the API accepts build
fields but they don't stick (all verified).

- **Workers & Pages** on [dash.cloudflare.com](https://dash.cloudflare.com/) →
  the project (e.g. `compositions-private`) → **Settings → Build &
  deployments** → **Connect to Git** → authorize Cloudflare's GitHub app (once
  per account) → pick the repo (`<owner>/compositions-private`), branch
  `main`, root directory `/`, no build command.
- The connection triggers an immediate git build; the page is live ~1 minute
  later.

**Diagnosing "not git-integrated":** the publish succeeds, but the URL 500s or
404s behind the login wall. `wrangler pages project list` shows
**Git Provider: No**. Fix = the connection above.

## 3 · Add or remove allowed emails (any time)

The tool creates the Access app with an allow policy for **exactly** the
`accessEmail` from `~/.config/jazz/cloudflare.json`. To change who gets in —
add a second person, remove someone, switch providers — do it in the
dashboard; **the tool never rewrites an existing app on re-publish, so manual
edits are preserved**:

- [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) →
  **Access → Applications** → the app named `jazz-<project>` (its service
  domain is `<project>.pages.dev`) → **Policies** → the allow policy →
  **Edit**.
- **Include** rules: add an **Email address** per person (that is the only
  per-address rule the current API accepts; a whole-domain rule — e.g. every
  `@acme.com` — is available if you want coarser control).
- **Exclude** rules: to kick someone out of a domain-wide allow, add their
  address here.
- Each visitor with an allowed address signs in with a one-time PIN sent to
  that email — no account, no device enrollment, 24h session.

## CLI checks (headless, no dashboard needed)

```bash
# Who is this token / is Access reachable?
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler whoami

# Is the project git-integrated? "Git Provider: Yes" = good.
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler pages project list

# Is the latest deployment serving? Preview subdomains skip the Access wall,
# so this tests the asset without a login. <short_id> = the deployment id.
curl -sIL https://<short_id>.compositions-private.pages.dev/<slug>
```

## Token & config

`~/.config/jazz/cloudflare.json`:

```json
{ "schemaVersion": 1, "token": "…", "accountId": "…", "accessEmail": "you@email.com" }
```

- **Token:** a scoped token with **Cloudflare Pages: Edit** and
  **Access: Apps: Edit**. The account ID is in the URL of any dashboard page
  (`dash.cloudflare.com/<accountId>/…`).
- **`accessEmail`:** the address the first allow policy admits. Change the
  config for _new_ projects; change the dashboard policy for _existing_ ones.
