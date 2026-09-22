# Jev decision provider

Jev is an optional Jazz plugin that uses TypeSafe's System One API to make a
small set of bounded decisions inside the harness. It does not replace Jazz's
primary model, execute tools, or own authorization. Jazz validates every answer
and keeps the final policy decision host-side.

The plugin is disabled by default. When it is enabled, it can improve three
parts of a run:

| Hook                    | What Jev sees                                                                        | What Jazz does with the answer                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route.skills`          | The current request and the names/descriptions of installed skills                   | Adds a short, transient hint about the most relevant skill before the first model request. It does not load a skill or grant a capability.                                                                              |
| `compact.tools`         | The current goal and bounded previews of old, large tool results                     | Chooses `keep`, `truncate`, or `drop` before summarization. Jazz replaces result content without removing messages, and falls back to the deterministic clearer when Jev abstains or fails.                             |
| `classify.command-risk` | Only the proposed shell command text for an otherwise-unknown `execute_command` call | Supplies evidence to Jazz's approval policy. A sufficiently confident `read-only` or `low-risk` result may avoid an approval prompt; uncertain or unavailable results stay high-risk or use Jazz's built-in classifier. |

## What leaves the machine

Requests go to `https://api.typesafe.ai/v1/systemone` using the pinned
`jev-1.13.0` model. The manifest declares the data classes sent:

- the current turn request and installed skill names/descriptions;
- proposed shell command text;
- tool names and result previews during compaction.

Conversation history, full tool-result bodies, environment variables, and file
contents are not sent by these hooks. The required credential is the
`TYPESAFE_API_KEY` environment variable or a Jazz-managed secret. Network use
may incur TypeSafe charges.

## Enable it

Install the reviewed catalog artifact, then enable it for an agent from a local
interactive terminal:

```bash
jazz plugin add com.jazz.plugins.jev
jazz plugin enable com.jazz.plugins.jev --agent default
```

Enabling a plugin is an explicit trust and data-egress consent decision. Jazz
verifies the artifact digest before importing it, and Jev falls back to
deterministic host behavior if its secret is missing, the provider times out,
returns an invalid answer, or the network is unavailable.

## Development

From this directory:

```bash
bun test
jazz plugin pack .
```

The plugin uses only the public `@jazz/plugin-sdk` ABI. Its manifest is the
reviewed contract for hooks, network destinations, data classes, and secrets;
the implementation is in [`src/index.ts`](./src/index.ts).
