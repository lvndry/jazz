# Cross-network peer-invite demo

Two jazz agents that can only reach each other through a reverse proxy — the same "over the
internet" topology [docs/guide/peers-setup.md](../../../docs/guide/peers-setup.md) documents,
simulated entirely on localhost with Docker, no real domain or external tunnel needed.

```
alice-net                    bob-net
┌────────┐                   ┌────────┐
│ alice  │──┐             ┌──│  bob   │
└────────┘  │             │  └────────┘
             ▼             ▼
          ┌───────────────────┐
          │       caddy        │  (the only thing on both networks)
          └───────────────────┘
```

`alice` and `bob` are on two separate Docker networks with no route between them at all —
`alice` cannot reach `bob`'s container by any address, and vice versa. `caddy` is attached to
both, proxying `/peer/ask` and `/peer-invites/*` to `bob`, exactly like a real reverse proxy
in front of a loopback-bound daemon. This is what `--public-url` on `jazz peers invite create`
exists for: bob's daemon has no address alice could ever reach directly, so the invite has to
advertise caddy's instead.

What this does **not** simulate: real TLS. That needs a real public domain to get a
certificate for, which a local demo has no way to provide — caddy proxies plain HTTP here. The
network isolation and reverse-proxy shape are real; the encryption is not.

Each container also runs a real headless keyring (`gnome-keyring` over a private D-Bus
session — see the `Dockerfile` and the top of `entrypoint.sh`), so the invite's token actually
gets persisted rather than hitting the "no keyring available" refusal a bare container would.

## Running it

```bash
cd scripts/peers/cross-network
OPENROUTER_API_KEY=... docker compose up --build
```

Bob provisions an agent, starts serving, and invites Alice — advertising `http://caddy` as his
address. Alice provisions her own agent, waits for the invite (dropped in a shared volume, not
sent over the network — that hand-off itself is out of band, same as a real invite link
would be), accepts it, and asks a real question. Watch for:

- `Invite URL (resolves to the caddy container, not bob's daemon directly): http://caddy/...`
- `Added "bob" as a peer and stored the shared token.`
- a real, model-generated answer to "what time is it on his machine"

Tear down (including the named volumes, so the next run starts with fresh agents):

```bash
docker compose down -v
```

## If it doesn't work

- **`no OS keyring is available`** — the gnome-keyring setup in `entrypoint.sh` failed to
  start. Check the container logs for `dbus-run-session`/`gnome-keyring-daemon` errors.
- **`Authentication failed for LLM provider "openrouter"`** — `OPENROUTER_API_KEY` wasn't
  actually set, or isn't valid.
- Everything up through "Added ... as a peer" succeeding but the final question failing proves
  the feature itself works — invite creation, the network-isolated HTTP round trip through
  caddy, secret hashing, redemption, and token storage. Only the model call needs a real key.
