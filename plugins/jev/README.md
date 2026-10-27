# Jev decision provider

Jev is an optional Jazz plugin that uses TypeSafe's System One API, through the
AI SDK's `@ai-sdk/typesafe-ai` provider, for small structured decisions. It gives
your agent 2 tools for judging many items at once, and answers decisions inside
the agent harness. It complements your agent's main model and pins `jev-1.14.0`.

## Tools for your agent

Once the plugin is enabled for an agent, the agent calls these tools for 15 or
more items, for items saved as files or images, or when it needs a probability
per item. Items can be text, a text file, a PNG or JPEG, or text plus an image,
each with an optional `id` that results use. `files` takes paths or glob
patterns, such as `inbox/*.eml`, and makes one item per matched file (directories
are skipped), so the agent never copies a file's contents into the call. Limits:
200 items per call; each item's text is cut to its first 8,000 characters, read
from the start of the file only, and marked `truncated`; images up to 16 MiB,
TypeSafe's per-image limit.

Each item goes to Jev in its own question, and items are split across requests
that fit Jev's 64,000-token input limit, 4 in flight at a time, so 50 emails cost
a few calls. Context or label descriptions too long for any request are refused
before anything is sent.

| Tool       | What the agent passes                                                                                | What it gets back                                                                                                                                            | Examples                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `classify` | Items and/or `files`, labels with short descriptions, and optionally `keep` (the labels to return)   | Each item's label, every label's probability, and Jev's confidence; `uncertain` when the label's probability is under 0.5; "none of these" is always offered | Triage an inbox, sort receipts into business and personal, check for a scam |
| `rank`     | Items and/or `files`, a criterion, optionally a scale from worst to best (2 to 10 levels), and `top` | Items best first, each with a 0-1 score, the nearest level, and Jev's confidence; equal scores go to the more confident item first                           | Shortlist apartments, job offers, or restaurants; order tasks by importance |

A tool error explains what to fix, such as a missing key, an unreadable image, or
a label list that is too short. If Jev declines to judge an item, the agent is told
to judge it itself.

## Harness decisions

| Capability                                            | How Jazz uses it                                                                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill routing (`route.skills`)                        | Ranks installed skills against your current request. Jazz can suggest the most relevant skill to the main model; the plugin does not load it itself.                                                              |
| Tool-result compaction (`compact.tools`)              | Recommends keeping, truncating, or dropping old tool-result content during context cleanup. Dropping requires a confident signal; uncertain large results are truncated. User and assistant text are untouched.   |
| Page classification (`classify.page`)                 | Flags a browser page that asks for a password, payment details, or a human check, or whose labels address an AI agent. A flag only adds scrutiny: `browser_act` then asks on every call there.                    |
| Snapshot routing (`route.snapshot`)                   | Ranks a page's interactive elements against your request so the browser snapshot lists the likely ones first. Every element stays in the snapshot.                                                                |
| Memory-pass gate (`gate.memory-pass`)                 | Before Jazz looks for facts and lessons to suggest (at compaction and when a chat closes), estimates whether the conversation holds any. Jazz skips the pass only when Jev is at least 90% sure there is nothing. |
| Command-risk classification (`classify.command-risk`) | Classifies proposed `execute_command` calls as read-only, low-risk, or high-risk before Jazz applies your approval policy.                                                                                        |

Errors, timeouts, invalid answers, and abstentions fall back to Jazz's built-in
behavior. Each decision gets one attempt, since a retry could not finish within
Jazz's 2-second hook deadline. For command risk, Jazz falls
back to its built-in classifier and treats unresolved classification as high-risk.

## Enable it

You need Jazz with plugin support and a TypeSafe API key. Run these commands in
your local terminal:

```bash
jazz plugin add com.jazz.plugins.jev
jazz plugin inspect com.jazz.plugins.jev
jazz plugin trust com.jazz.plugins.jev
jazz plugin enable com.jazz.plugins.jev --agent default
```

Replace `default` with your agent's name or ID. To enable Jev for every agent,
including agents created later, omit `--agent`:

```bash
jazz plugin enable com.jazz.plugins.jev
```

`enable` asks for the required `apiKey` when it is missing and stores it in Jazz's
secure storage. Alternatively, provide `TYPESAFE_API_KEY` in the environment of
the Jazz process; it takes precedence over the stored key. If secure storage is
unavailable, use that environment variable.

To set or replace the stored key later, use the interactive secret prompt:

```bash
jazz plugin secret set com.jazz.plugins.jev apiKey
jazz plugin secret status com.jazz.plugins.jev apiKey
jazz plugin doctor com.jazz.plugins.jev
```

For a local checkout, replace the `add` command above with this command from the
Jazz repository root, then follow the same inspect, trust, and enable steps:

```bash
jazz plugin add ./plugins/jev
```

## Data and approvals

Jev sends decision inputs to `https://api.typesafe.ai/v1/systemone`: the current
request and installed skill names/descriptions for routing; proposed shell command
text for risk classification; and the goal plus bounded tool-call metadata,
inputs, and result previews for compaction. For browser pages it sends the page's
origin (never the path or query), its title, each interactive element's role and
label, and whether the page has a password or payment card field; snapshot routing
also sends your latest request. It never sends the page body, link targets, or
field contents. The `classify` and `rank` tools send the items, labels, criterion,
and context the agent passes them, including the text and image files it names. The
memory-pass gate sends your messages and the assistant's replies, never tool
output, and only for conversations up to 32,000 characters. These are
external API calls using your TypeSafe account.

TypeSafe documents that text written to steer a verdict can move it, and page
titles and labels are written by the page. Treat a Jev page flag as an extra alarm,
never as the boundary: Jazz also reads the page's own structure, and no answer can
lower a risk, skip an approval, or clear the untrusted-content marking.

Plugins execute inside Jazz with your OS-user authority; they are not sandboxed.
Inspect the declarations before trusting and enabling the plugin. Command-risk
classification can remove an approval prompt when a command's classification is
covered by your active approval policy. Jazz still enforces its tool permissions,
command allowlists, and shell denylist.

## Disable it

```bash
# Disable for one agent:
jazz plugin disable com.jazz.plugins.jev --agent default

# Disable for all agents:
jazz plugin disable com.jazz.plugins.jev
```

Restart long-running Jazz processes, such as bots or daemons, to fully unload
already-imported plugin code.

See the [plugin guide](../../docs/configure/plugins.md) for updates, removal,
secrets, and the full trust lifecycle, or the [implementation](src/index.ts) and
[manifest](jazz-plugin.json) for the exact decision rules and declarations.
