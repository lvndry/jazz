# Private publishing: Cloudflare setup & the manual steps

Private compositions are served by Cloudflare Pages from a **private** GitHub
repo, behind a **Cloudflare Access** sign-in. Most of it is automatic; a small
number of things live in the Cloudflare dashboard because they are OAuth or
change who can open a private page.

> **Needs a backend instead?** If the composition requires shared state,
> multiple browsers, hourly updates, or a real database, use
> `references/backend-worker-d1.md` — the static Pages frontend + Worker +
> D1 (SQLite) + cron pattern, all via the `cf` CLI. This guide is the
> static-only flow.

## What is automatic vs manual

| Step                                 | Where                        | When                  |
| ------------------------------------ | ---------------------------- | --------------------- |
| Create the private repo              | `gh`, automatic              | first private publish |
| Create the Pages project             | Cloudflare API, automatic    | first private publish |
| Create the Access app + allow policy | Cloudflare API, automatic    | first private publish |
| **Enable the Access service**        | **Cloudflare One dashboard** | **once, per account** |
| **Enable One-time PIN sign-in**      | **Cloudflare One dashboard** | **once, per account** |
| **Add / remove allowed emails**      | **Cloudflare One dashboard** | **any time**          |

Everything else — pushing the file, deploying, re-publishing — is what the
tool does.

## 1 · Enable the Access service (once per account)

Open [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) — this is the
**Cloudflare One / Zero Trust portal, not the main dashboard** — and click
**Enable Access**. Free and one-time. Without it, Access-app creation fails
with `access.api.error.not_enabled`, and the tool tells you exactly that.

## 2 · Enable One-time PIN sign-in (once per account)

Without this step the sign-in page **only offers “Continue with Cloudflare”** —
new Zero Trust organizations ship with the Cloudflare account IdP as the only
login, so people you invite would need a Cloudflare account of their own.
Email-only sign-in needs the built-in **One-time PIN** IdP enabled at the
_account_ level first:

1. Cloudflare dashboard → **Zero Trust** ([one.dash.cloudflare.com](https://one.dash.cloudflare.com/))
2. **Integrations → Identity providers** (the account-level list — _not_ the
   app's “Choose available identity providers” screen, which only shows IdPs
   already created here)
3. **Add new identity provider** → **One-time PIN**
4. Enable it (free on the Zero Trust Free plan)

Then open each Access app (Access → **Applications** → `jazz-<project>-<number>` →
**Edit** → **Choose available identity providers**) and tick **One-time PIN**
so the app offers it. Now the sign-in page shows “Continue with email”: the
visitor types their address, gets a one-time code in their inbox, enters it —
**no Cloudflare account needed**. (API equivalent: `POST
/access/identity_providers` with `{name, type: "onetimepin", config: {}}`, then
attach its id to the app's `allowed_idps` — needs the _Identity Providers:
Edit_ token permission, which the dashboard path above doesn't.)

## Deployment and private protection

The tool deploys a complete snapshot of the checkout's `compositions/` tree through
Cloudflare's asset API. Git integration is optional; it is not a fallback for a
failed direct deployment. If an existing project is Git-integrated, Access is
configured before the push that can trigger a build.

Private publishing verifies the repository is private and installs email Access
policies for the project's assigned hostname, its wildcard deployment aliases,
and attached custom hostnames before pushing or uploading content. The project
hostname can have a suffix when its requested name is already taken; returned
links and Access scopes use the assigned hostname. `pagesHost` must already be
attached to the project. Its private scope is `/compositions/private`.

If Access setup or policy verification fails, nothing is pushed or uploaded.
A failed deployment is reported as an error. If an existing page returns an error,
check the project's deployment status and Access configuration before republishing.

## 3 · Add or remove allowed emails (any time)

The tool creates the Access app with an allow policy for **exactly** the
`accessEmail` from `~/.config/jazz/cloudflare.json`. To change who gets in —
add a second person, remove someone, switch providers — do it in the
dashboard; **compatible email allow lists are preserved on re-publish**. Update every
application protecting the project, including deployment aliases:

- [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) →
  **Access → Applications** → each app named `jazz-<project>-<number>` (the assigned Pages hostname,
  its wildcard deployment aliases, and any custom domains) → **Policies** → the allow policy →
  **Edit**.
- **Include** rules: add an **Email address** per person (that is the only
  per-address rule the current API accepts; a whole-domain rule — e.g. every
  `@acme.com` — is available if you want coarser control).
- **Exclude** rules: to kick someone out of a domain-wide allow, add their
  address here. Bypass policies, public destination overrides, and non-email
  allow selectors must be removed before the tool can verify private publication.
- Each visitor with an allowed address signs in with a one-time PIN sent to
  that email — no account, no device enrollment, 24h session.

## CLI checks (headless, no dashboard needed)

```bash
# Who is this token / is Access reachable?
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler whoami

# Find the assigned project hostname and deployment status.
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler pages project list

# Canonical and immutable deployment URLs must both redirect to Access sign-in.
# Use the assigned hostname and deployment id from the project response.
curl -sIL https://<assigned-host>/compositions/private/<slug>/
curl -sIL https://<deployment-id>.<assigned-host>/compositions/private/<slug>/
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
