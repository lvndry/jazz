# WhatsApp bridge

Chat with a [Jazz](../../README.md) agent from WhatsApp. The bridge links to
your account as a device — the same standing WhatsApp Web has in a browser — and
answers every message you send it, with per-chat memory, per-chat model and
persona, reminders, and attachments.

```text
WhatsApp  ◀──(Baileys, WhatsApp Web protocol)──▶  bridge  ──jazz run --json──▶  OpenAI / Ollama / …
```

## Read this before you run it

WhatsApp publishes no API for personal accounts.
[Baileys](https://github.com/WhiskeySockets/Baileys) implements the WhatsApp Web
protocol by reverse engineering, which has consequences you are accepting:

- **Meta does not sanction this.** A number that behaves unusually — bursts of
  messages, replies at machine speed, many new conversations — can be rate
  limited or banned. Run it on a **dedicated number** if the account matters.
- **The link can be cut.** Unlinking the device from your phone, or WhatsApp
  deciding to, ends the session; the bridge says so and exits rather than
  looping.
- **It is a full device.** Everything that account receives, this process
  receives. The allow-list decides what it *answers*, not what it *sees*.

The official alternative is the WhatsApp Cloud API, which needs a Meta Business
account and a separate business number, and only permits template messages
outside a 24-hour reply window — unusable for a personal assistant, which is why
this bridge does not use it.

## Requirements

- The phone whose WhatsApp account is being linked.
- A model backend: an API key for a cloud provider, or a local
  [Ollama](https://ollama.com) with a tool-capable model pulled.

## Quick start

```bash
WHATSAPP_ALLOWED_NUMBERS="+15551234567" \
OPENAI_API_KEY=sk-… \
bun packages/whatsapp-bot/src/bridge.ts
```

On first run it prints a QR code — WhatsApp → Settings → Linked Devices → Link a
device. On a headless machine there is no camera to point at it, so set
`WHATSAPP_PAIR_NUMBER` to the account's number instead and it prints an
8-character code to type into WhatsApp under **Link with phone number**.

Credentials land in `WHATSAPP_AUTH_DIR` and the pairing is not repeated.
Anything that can read that directory can act as the account.

## Configuration

| Variable                             | Default                | What it does                                                                                        |
| ------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `WHATSAPP_ALLOWED_NUMBERS`           | _(required)_           | Comma-separated numbers allowed to DM the agent. Written however you like; compared as digits.        |
| `WHATSAPP_ALLOWED_GROUPS`            | _(none)_               | Comma-separated group JIDs the agent will speak in. Being allowed to DM does **not** admit you here.  |
| `WHATSAPP_REQUIRE_MENTION_IN_GROUPS` | on                     | In an allowed group, only answer when @-mentioned or replied to. Turning this off makes it answer everything. |
| `WHATSAPP_PAIR_NUMBER`               | _(none)_               | Link by 8-character code instead of QR. The account's own number.                                     |
| `WHATSAPP_AUTH_DIR`                  | `$JAZZ_HOME/wa-auth`   | Linked-device credentials.                                                                            |
| `JAZZ_BIN`                           | `jazz`                 | Path to the Jazz binary.                                                                              |
| `JAZZ_HOME`                          | `~/.jazz-whatsapp`     | Data directory: agents, conversations, reminders, usage.                                              |
| `JAZZ_WHATSAPP_AGENT`                | `whatsapp`             | Seed agent every per-chat agent is cloned from.                                                       |
| `JAZZ_APPROVAL_POLICY`               | `low-risk`             | Tier above which tools stop and ask.                                                                  |
| `JAZZ_AUTO_APPROVE_TOOLS`            | _(none)_               | Tool names that never prompt, whatever the policy.                                                    |
| `JAZZ_RUN_TIMEOUT_MS`                | `300000`               | Per-turn timeout.                                                                                     |
| `JAZZ_DAILY_COST_CAP_USD`            | `0` (off)              | Spend ceiling across all chats per day.                                                               |
| `JAZZ_WHATSAPP_SHOW_REASONING`       | off                    | Send the run's reasoning under the answer.                                                            |

## Commands

Same set as the other bridges: `/new`, `/model provider/model`, `/persona name`,
`/mode safe|yolo`, `/tz Europe/Paris`, `/status`, `/help`. A message starting
with `/` that is not one of these goes to the agent unchanged.

WhatsApp buttons are restricted to business accounts and silently degrade to
nothing on a personal one, so approvals and questions arrive as numbered
options you answer by replying with a number. A reply that matches no option is
treated as an ordinary message.

## Finding a group's JID

Group JIDs look like `120363043211234567@g.us`. The simplest way to get one is
to run the bridge, send a message in the group, and read the line it logs about
ignoring a message from a group that is not on the list.
