# Peer-invite demos

Two ways to see [peer setup](../../docs/start/peers-setup.md) actually work, end to end,
with real agents and a real model — the part
[`packages/adapters/src/daemon/peer-invite-flow.test.ts`](../../packages/adapters/src/daemon/peer-invite-flow.test.ts)
deliberately doesn't cover, since a model's actual answer isn't something a deterministic CI
run should depend on.

| Script                                      | What it proves                                                                                         | Needs                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [`two-agents-localhost.sh`](./two-agents-localhost.sh) | The whole flow on one machine: two agents, an invite, a real question and answer.                | An OpenRouter key (or one already in your keyring) |
| [`cross-network/`](./cross-network/)         | The reverse-proxy topology specifically — two Docker networks with no route between them, bridged only by a Caddy container, exercising `--public-url`. | Docker, an OpenRouter key |

Both provision their agents non-interactively via
[`provision-agent.ts`](./provision-agent.ts), since `jazz agent create` is an intentional,
interactive-only wizard (see that file's header for why writing the agent JSON directly is the
documented way to script this).

Run either with no arguments:

```bash
./scripts/peers/two-agents-localhost.sh

cd scripts/peers/cross-network && docker compose up --build
```

See [`cross-network/README.md`](./cross-network/README.md) for the Docker demo's own details
(network layout, the headless keyring it sets up, troubleshooting).
