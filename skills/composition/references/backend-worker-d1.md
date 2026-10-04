# Backend for stateful compositions (Worker + D1), via the cf CLI

When a composition needs shared state (more than one browser, data that must
persist and tick), the pattern that worked for the `patrimoine` household
dashboard (see `compositions-private` → `networth/` for a full working
example) is: **static Pages frontend + one Cloudflare Worker + D1
(managed SQLite) + scheduled cron** — all serverless, all on the same
account as the Pages project, all in the free tier for personal scale.

Everything below is done with the **cf CLI** (`cf auth login` once per
machine; the OAuth token covers Workers, D1, and Zero Trust in this
account). `wrangler` is superseded by `cf`; it survives only as a
build-time devDependency because `cf deploy` bundles through it.

## 1 · D1 database

```sh
cf d1 create --name my-app            # returns { uuid, name, ... } — keep the uuid
```

`cf d1 query <DATABASE_ID> --sql "..."` works for single statements but
**chokes on multi-statement SQL** (batch bodies get rejected by the query
endpoint). Apply a schema file statement by statement with a small helper
(`compositions-private/networth/apply-d1.mjs` is a working one):

```sh
node apply-d1.mjs <DATABASE_ID> db/schema.sql db/seed.sql
```

Known D1 query-API limits, learned the hard way:

- **`PRAGMA user_version` is not supported** (read or set → `SQLITE_AUTH`).
  Keep the schema version of record in a `meta(key, value)` row instead.
- **`INSERT OR IGNORE` alone is not idempotency.** A plain `id INTEGER
PRIMARY KEY` table will silently duplicate rows on every re-apply. Give
  every seed table a **natural UNIQUE key** (`UNIQUE (name)`,
  `UNIQUE (vehicle, event_month)`, …) _and_ put `IF NOT EXISTS` on
  `CREATE TABLE` / `CREATE INDEX`. Then re-running the seed is safe.
- Quote-aware splitting: seed strings contain `;` (e.g. French rules text)
  and escaped `''` apostrophes — a naive `split(';')` will corrupt them.

Verify with:

```sh
cf d1 query <DATABASE_ID> --sql "SELECT COUNT(*) AS n FROM accounts"
```

## 2 · Worker + config

Config lives in `cloudflare.config.ts` (typed config; `wrangler.jsonc` is
legacy). The import is **`cf/config`** (from the `cf` npm package) —
`cloudflare:config` is not resolvable at bundle time. `cf migrate` can
convert an existing `wrangler.jsonc` (it needs a local wrangler ≥ 4.100).

```ts
// cloudflare.config.ts
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "my-app-worker",
    compatibilityDate: "2026-01-01",
    entrypoint: "worker.js",
    triggers: [triggers.scheduled({ schedule: "0 * * * *" })], // hourly
    env: {
      DB: bindings.d1({ name: "my-app", id: "<DATABASE_ID>" }),
    },
  },
});
```

```sh
npm i --save-dev wrangler cf   # build-time only — no runtime process
cf deploy                       # → https://<name>.<account>.workers.dev
```

Notes:

- An editor LSP will flag `cf/config` as an unresolvable module. That's
  expected — the CLI resolves it at deploy time.
- Keep the pure functions (parse, validate, recompute) exported from
  `worker.js` and cover them with `node --test` — the worker runs
  untested-in-production otherwise. A local mock of the API (a ~100-line
  `node:http` server with fixtures) lets you develop the frontend in a real
  browser without touching Cloudflare.

## 3 · Frontend → API wiring

- **CORS**: echo the request origin from an **allow-list** (the
  `pages.dev` origin + `http://127.0.0.1:<port>` / `localhost` for local
  dev). A single hardcoded origin breaks local development; `*` breaks
  `credentials`.
- **Fetch**: cross-origin API calls need `credentials: "include"`, or the
  browser won't send the Access cookie (see §4).
- **Auth-redirect handling**: when not signed in, the API 302s to the
  Access login page. Detect it (`res.redirected`), show an
  "Access sign-in required" banner with a link to the login URL, and never
  render a white screen.

## 4 · Protect the worker with Access — via CLI

Creating a **self-hosted Access app** for the `workers.dev` hostname **is**
the "Enable Access" step — there is no separate toggle for `workers.dev`
domains (unlike the dashboard's per-worker button flow). The app + policy
in one command:

```sh
cf zero-trust access applications create --body '{
  "type": "self_hosted",
  "name": "my-app-worker",
  "domain": "my-app-worker.<account>.workers.dev",
  "self_hosted_domains": ["my-app-worker.<account>.workers.dev"],
  "destinations": [{ "type": "public", "uri": "my-app-worker.<account>.workers.dev" }],
  "app_launcher_visible": false,
  "allowed_idps": ["<IdP id>"],
  "auto_redirect_to_identity": true,
  "session_duration": "24h",
  "policies": [{
    "decision": "allow",
    "name": "my-app-allow",
    "include": [
      { "email": { "email": "you@example.com" } },
      { "email": { "email": "them@example.com" } }
    ],
    "require": []
  }]
}'
```

Gotchas (all hit in the wild):

- **`allowed_idps`** must be the account's real IdP id. `oidc_cloudflare`
  is _not_ it — read the id from an existing app:
  `cf zero-trust access applications get <existing-app-id>`.
- **Specific email addresses work in `include`** even when a dashboard
  form only seems to offer "domain". The API is the source of truth; when
  the UI and the API disagree, the API wins.
- **`session_duration`** must be set explicitly — the dashboard default
  (3 days) is not honored by the API path.
- New emails don't need a Cloudflare account: first visit → one-time code
  emailed → 24h session cookie.

Manage emails later (the `include` list is replaced, not merged — pass the
full list):

```sh
cf zero-trust access policies list
cf zero-trust access policies update <POLICY_ID> \
  --body '{"decision":"allow","include":[{"email":{"email":"new@example.com"}}],"require":[]}'
```

Verify the gate:

```sh
curl -s -o /dev/null -w "%{http_code} → %{redirect_url}\n" \
  https://my-app-worker.<account>.workers.dev/api/health
# 302 → https://…cloudflareaccess.com/cdn-cgi/access/login/… = gate live
# 200 = still open
```

## 5 · Hourly cron verification

```sh
cf d1 query <DATABASE_ID> --sql "SELECT value FROM meta WHERE key='last_cron'"
# should be < 2h old. Force a cycle:
curl -X POST https://my-app-worker.<account>.workers.dev/api/prices/refresh
```

Live logs while `cf` doesn't stream them yet:
`npx wrangler tail my-app-worker`.
