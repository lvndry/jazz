---
description: "Run a real tool-using AI agent inside Telegram, Discord, iMessage, WhatsApp, Slack, or your own app: same agent, same tools, same approval rules as the terminal."
---

# Chat platforms

Reach an agent from your phone or team channel. It can inspect files, work with git,
research questions, and ask for approval before taking actions on the machine hosting it.

| Platform                         | What you need                                      | Setup                                                                             |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Telegram                         | Bot token, allowlisted chat id, Docker             | [Telegram guide](../guides/deploy-a-chat-agent.md#telegram)                       |
| Discord                          | Bot token, allowed users/channels/server, Docker   | [Discord guide](../guides/deploy-a-chat-agent.md#discord)                         |
| iMessage, hosted                 | Photon project and allowed handles; Linux or macOS | [Hosted-line guide](../guides/deploy-a-chat-agent.md#imessage-with-a-hosted-line) |
| iMessage, local                  | Awake Mac on macOS 14+, signed into Messages       | [Local-Mac guide](../guides/deploy-a-chat-agent.md#imessage-through-your-own-mac) |
| WhatsApp                         | Linked account, allowed numbers, running bridge    | [WhatsApp guide](../guides/deploy-a-chat-agent.md#whatsapp)                       |
| Slack, Google Chat, your own app | A custom adapter                                   | [Custom integrations](#slack-google-chat)                                         |

Each supported bridge keeps conversation history and accepts `/model`, `/persona`,
`/remind`, `/status`, and `/stop`. Configure a model provider before starting one.

## Try a useful request

Once connected, send a request appropriate to the files and integrations available on
its host:

```text
Review today's commits and tell me what needs attention.
Summarize the PDF I attached and list the decisions I need to make.
/remind 30m Check the deployment
```

Email, calendar, and web search need their own [integration setup](../configure/index.md).
A Docker bridge sees its container's files and mounts; it does not automatically see
your laptop's checkout.

---

## Telegram (shipped)

Follow the [Telegram setup](../guides/deploy-a-chat-agent.md#telegram) to create a bot,
set its token and allowed chat ids, and start the container. Message the bot directly;
it shows tool activity and reasoning while the run works.

| You want to     | Send or choose                                                                    |
| --------------- | --------------------------------------------------------------------------------- |
| Change model    | `/model` for a picker, or `/model provider/model` after configuring that provider |
| Change behavior | `/persona`                                                                        |
| Stop a run      | `/stop` or the stop button                                                        |
| Approve a tool  | Accept or reject its approval message; batch buttons answer several at once       |
| Set a reminder  | `/remind 30m check the deploy`                                                    |

Each chat has its own agent settings and conversation. In the default Linux container
setup, chat agents run under separate Unix users. Provider keys still bill the operator's
accounts. See [per-chat isolation](../../packages/telegram-bot/README.md#per-chat-isolation).

---

## Discord (shipped)

Follow the [Discord setup](../guides/deploy-a-chat-agent.md#discord), including Message
Content Intent and the allowlist. Mention the bot in an allowed channel to start a thread;
follow-ups in that thread need no mention. DMs require your user id to be allowed.

When it asks for an answer or approval, the person who started the run can reply in the
same channel without another mention. Ordinary mention requirements resume afterward.

Use `/model` for the current provider's model picker. To change providers, send
`/model provider/model` as a normal message after adding that provider's credential.

The default Linux container isolates conversations under separate Unix users. See
[per-conversation isolation](../../packages/discord-bot/README.md#per-conversation-isolation).

---

## iMessage and WhatsApp (shipped)

```bash
jazz imessage             # hosted line through Photon; no Mac required
jazz imessage --local     # your Apple account; macOS 14+
jazz whatsapp     # links as a device, the way WhatsApp Web does
```

Setup walkthrough: [Reaching your agent from a chat app](../guides/deploy-a-chat-agent.md#imessage-with-a-hosted-line).
Full tables: [`packages/imessage-bot/README.md`](../../packages/imessage-bot/README.md),
[`packages/whatsapp-bot/README.md`](../../packages/whatsapp-bot/README.md).

| Concern              | What changes                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where it runs**    | Local iMessage needs an awake, signed-in Mac. Photon can run anywhere but carries messages through a third party. WhatsApp needs its linked-device process alive.                                                                |
| **No buttons**       | Approvals arrive as numbered options answered by replying `1` or `2`. A reply matching nothing is treated as an ordinary message, so an ignored prompt never swallows the next question.                                         |
| **No live progress** | iMessage cannot edit a sent message: `🤔 Working…`, a "still working" line at 45s and roughly once a minute after, then the answer. No status bubble to update.                                                                  |
| **Stopping a run**   | Send `/stop`. It is answered at once, like `/status`, `/help` and `/new`, rather than waiting behind the run it would stop.                                                                                                      |
| **Formatting**       | WhatsApp gets the model's Markdown in its own dialect (`*bold*`, `_italic_`, `~strike~`, code blocks); Messages gets plain text with the marks dropped. Math becomes Unicode on both (see below).                                |
| **Whose account**    | iMessage answers as _you_, so a chat with yourself needs a trigger word to tell questions from the bridge's own replies. Photon gives the agent a line of its own instead: [`packages/photon-bot/`](../../packages/photon-bot/). |
| **Allow-list shape** | Handles (E.164 or Apple ID) and group rowids for iMessage; numbers and group JIDs for WhatsApp. Both deny-by-default; being allowed to DM never admits you to a group.                                                           |
| **Isolation**        | Per-conversation uid sandboxing is a Linux mechanism the containerised bridges use. On a Mac or a linked device every chat shares one `JAZZ_HOME` and runs as your user.                                                         |
| **Sanctioning**      | WhatsApp publishes no API for personal accounts; the bridge speaks the WhatsApp Web protocol via Baileys. Unusual behaviour can get a number limited or banned. Use a dedicated one if it matters.                               |

**Secrets the agent asks for** (`ask_user_secret`, a PDF password, say) are collected only in a
one-to-one chat with the bot: your next message is the value, it goes to the run over its private
pipe and is never forwarded as a turn, and the agent sees only `[redacted:<name>]`. Telegram deletes
your message once it is read; Discord, WhatsApp and iMessage bots cannot, so the prompt asks you to
delete it. In a group, a server channel or a Photon space the secret is not collected, and the chat
is told to take it to a private chat. See
[Secrets the person types](../security/secrets-and-egress.md#secrets-the-person-types).

---

### Math

Chat apps cannot typeset LaTeX, so a formula in a reply is rewritten as Unicode text before it is
sent: `$x_i^2 + \alpha$` reads `xᵢ² + α`. This applies to Telegram, Discord, WhatsApp and iMessage.
A block that spans lines (a matrix, aligned equations) goes in a code block so its columns line up.
Formulas inside code are left as written.

## Slack, Google Chat

Jazz does not ship adapters for Slack or Google Chat. A custom adapter must handle
the platform's authentication, conversation IDs, formatting, and acknowledgement deadlines:

| Concern              | Telegram                          | Discord                                           | Slack                                 | Google Chat            |
| -------------------- | --------------------------------- | ------------------------------------------------- | ------------------------------------- | ---------------------- |
| **Inbound**          | `getUpdates` long-poll or webhook | Gateway websocket                                 | Events API webhook (or Socket Mode)   | Chat app webhook       |
| **Conversation key** | `chat_id`                         | DM channel id, or thread id                       | `channel + thread_ts`                 | `space + thread name`  |
| **Reply formatting** | Markdown / HTML                   | Markdown (close to standard)                      | `mrkdwn` (`*bold*`, no `#` headings)  | app card or plain text |
| **Live progress**    | edit the status message           | edit the status message                           | `chat.update` on a placeholder        | update the card        |
| **Ack deadline**     | none                              | **3 s** for interactions                          | **3 s**: ack, then reply async        | **30 s**               |
| **Authorization**    | chat-id allowlist                 | user / channel / guild allowlist + mention-gating | verify signing secret, then allowlist | verify bearer token    |

Two things to get right, both platform-side:

1. **Ack fast, answer later.** Slack will retry a webhook you don't ack within 3 seconds,
   and an agent run takes longer than that. Ack immediately, run `jazz run` in the
   background, and post the answer as a follow-up. Retries are also why you should
   de-duplicate on the platform's event id: otherwise a slow run gets billed twice.
2. **Translate the markdown.** `jazz run` without `--json` gives you raw markdown
   precisely so you can convert it. Slack's `mrkdwn` in particular is not markdown.

---

## Sending yourself a message

Use a bridge's `notify.sh` script to send a message from a shell or scheduled job:

```sh
~/jazz/packages/telegram-bot/src/notify.sh "backup finished, 41 GB, no errors"
~/jazz/packages/discord-bot/src/notify.sh "nightly update rolled back, needs a look"
```

It reads the same `.env` the bridge runs on and posts to the first allowed chat
(`TELEGRAM_ALLOWED_CHAT_IDS`, or `DISCORD_ALLOWED_CHANNEL_IDS`).

The script sends directly through the platform API without starting an agent run or calling a model.

To notify after a job:

```sh
./long-job.sh && notify.sh "long-job: done" || notify.sh "long-job: FAILED ($?)"
```

The script exits non-zero and explains itself if the credentials are missing, so a caller
can note that without failing whatever it was doing:

```sh
notify.sh "..." || echo "(notify failed)"
```

## Security for chat surfaces

Restrict who can reach the bot and what their runs may do.

- **Always use an allowlist.** Both bridges and Jazz have one; use both.
- **Default to `low-risk`.** At `high-risk`, a message (or a prompt injection inside a web page the agent fetched) can run arbitrary commands on the host.
- **Know what "yolo" costs.** Every bridge's `/mode yolo` is `high-risk` for that conversation, and it is sticky: it survives `/new` and bridge restarts until someone sets it back to safe. Only an operator can turn it on (`TELEGRAM_OPERATOR_IDS`, `DISCORD_OPERATOR_IDS`, `WHATSAPP_OPERATOR_NUMBERS`, `IMESSAGE_OPERATOR_HANDLES`, `PHOTON_OPERATOR_HANDLES`; the iMessage account owner always is one), and the same goes for Telegram's "Always allow". Anyone admitted can turn it back to safe. With no operators configured, nobody can turn approvals off from chat.
- **An approval belongs to whoever asked.** In a group, only the person whose message started a run can approve, reject or answer its prompts; a tap or a typed `1` from anyone else does nothing. Cancelling is theirs too, or an operator's.
- **A run gets an allowlisted environment.** The bridge passes an agent run its PATH, locale and time zone, proxies, the provider keys and endpoints Jazz reads, and Jazz's own switches. The bot token, webhook secret, WhatsApp and Photon credentials, the daemon token, and anything else in the bridge's environment are left out, so an agent that runs `env` cannot hand the bot to whoever asked. A message and an incognito transcript reach the run on stdin, never on the command line, where every account on the host could read them.
- **Deny dangerous tools explicitly.** `tools` is additive, so omitting `execute_command` does not remove it. Put exact names such as `execute_command` in the agent's `deniedTools`; Jazz applies denials after every grant.
- **Treat the history volume as sensitive.** Transcripts are plaintext JSON under `~/.jazz/history/`.
- **Allowlisting is not isolation.** Two people on the same allowlist share a host, and a Jazz agent has `read_file` and `execute_command`, so without an OS boundary either one's agent can read the other's transcripts, memory and stored credentials. Both bridges give each conversation its own uid and Jazz home for exactly this: [Telegram](../../packages/telegram-bot/README.md#per-chat-isolation), [Discord](../../packages/discord-bot/README.md#per-conversation-isolation). It matters most where the allowlist is a **guild**, since that admits everyone in it. Anything you build yourself needs the same, or a one-person allowlist.
- **A container is not a boundary against the host.** Root, `sudo`, and the `docker` group all read a bridge's volume whatever its uids and file modes say: the daemon runs as root, and the docker group is root-equivalent. On a machine other people administer, treat everything the bot has stored as readable by every admin on it.
- **Check health.** Telegram and Discord expose `/health` for their container health checks. It returns `503` when the platform connection fails. For the other bridges, set `JAZZ_BRIDGE_HEALTH_PORT`. A restart stops active runs; waiting for your approval does not count against the run timeout.
- **Cap concurrency.** `JAZZ_BOT_MAX_CONCURRENT_RUNS` (default 4) bounds how many agent runs one bridge has in flight across every chat, and `JAZZ_BOT_MAX_QUEUED_MESSAGES` (default 5) how many messages may wait behind one chat's run.
- **Cap spend.** Use `costKnown` as well as `costUSD`. The bridges pause subsequent requests after an unpriced run; no dollar cap can guarantee the cost of that first unpriced request.

See the [security model](../security/index.md).

---

## Related

- [Headless](./headless.md): the contract every bridge uses
- [`packages/telegram-bot/`](../../packages/telegram-bot/): Telegram setup
- [`packages/discord-bot/`](../../packages/discord-bot/): Discord setup
- [`packages/photon-bot/`](../../packages/photon-bot/): hosted iMessage line
- [`packages/imessage-bot/`](../../packages/imessage-bot/): local iMessage through your Mac
- [`packages/whatsapp-bot/`](../../packages/whatsapp-bot/): WhatsApp, as a linked device
- [Local and air-gapped models](../getting-started/local-models.md): keeping inference local and enforcing egress controls

Failed reminder deliveries remain queued and are retried.
