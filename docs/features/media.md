---
description: "Compose one Jazz agent from specialist models for image, audio, and video understanding and generation without changing its identity, tools, or memory."
---

# Model companions for images, audio, and video

A Jazz agent does not need one model to be good at everything. Keep the primary model that is
best for reasoning and tool use, then bind specialist models to media roles:

```json
{
  "config": {
    "llmProvider": "openai",
    "llmModel": "gpt-5.4-mini",
    "companions": {
      "analyze:image": "anthropic/claude-haiku-4-5",
      "analyze:audio": "gemini/gemini-2.5-flash",
      "analyze:video": "gemini/gemini-2.5-flash",
      "generate:image": "gemini/gemini-3-pro-image"
    }
  }
}
```

The result is one stable agent, with the same persona, conversation, memory, tools, and
surface, and different models doing the parts they are actually good at. A cheap text model can orchestrate a
run, a vision model can inspect screenshots, and a different image model can render the final
asset. Each role can use a different provider, price point, and privacy boundary.

The six independent roles are `analyze:image`, `analyze:audio`, `analyze:video`,
`generate:image`, `generate:audio`, and `generate:video`. Analysis and generation are separate
because a model that understands a medium is not necessarily the model you want to create it.

## How delegation works

When the main agent delegates media work, Jazz starts a bounded, ephemeral companion run:

1. Jazz resolves up to eight named files and verifies their media type.
2. The companion receives the files plus a self-contained analysis task, and none of the parent
   conversation, tools, or memory.
3. It runs with no tools, at most four iterations, and a 30-minute timeout.
4. An analysis result returns as text. Generated media is saved under `$JAZZ_HOME/generated/`
   and returned as an artifact on the current surface.
5. The companion cost is added to the parent run, which then continues the job.

This is different from a subagent. A subagent inherits the parent's model and a bounded version of
its tools for general delegated work. A companion changes the model specifically to cross a media
capability boundary.

## Interactive and unattended selection

In the terminal, an unbound agent can ask you to choose among currently configured models that
support the requested role. The approval card shows the provider and known price. Jazz never
silently chooses a paid provider.

CI, schedules, webhooks, and chat bridges cannot stop at a picker. Bind every role the job may use in the agent
JSON before running unattended. That binding is standing consent to send the selected media and
task to that provider.

For one headless run, override analysis companions without changing the saved agent:

```bash
jazz run --agent analyst --with-vision anthropic/claude-haiku-4-5 \
  "Read @/tmp/dashboard.png and identify the failing service and time window"
```

Equivalent flags exist for `--with-audio` and `--with-video`.

## Attachments and generated files

Use `@path` in a terminal message or prompt to attach a local file. Chat bridges translate their
platform attachments into the same structured message format. If the primary model already accepts
that media type, Jazz can send it directly; `analyze_media` remains available when specialist
perception would be more accurate or economical.

For generation, the parent gives the companion a self-contained brief. The resulting image, audio,
or video belongs to the parent run: terminal output links it, JSON output reports it as an artifact,
and chat bridges upload it when the platform supports that medium. A capable primary model can
still emit media directly; a `generate:*` binding lets you choose a specialist without replacing
the agent's reasoning model.

`jazz agent list --can image|audio|video` finds configured agents that can produce a medium,
either by their own model or by a bound `generate:*` companion marked `via companion`, and
suggests capable models when none can. Companion bindings are configured independently in the agent file, so one
agent can use six different specialists if the work calls for it.

## Security and cost

A companion receives its input through its provider and therefore creates egress even when the
parent uses a local model. A generation brief can be sensitive too. Bind only providers permitted
to receive that material. The child
cost contributes to the parent run's aggregate cost; if any child price is unknown, `costKnown` is
false rather than pretending the run was free.

Build a working version in [Turn incident evidence into a visual briefing](../guides/media-companions.md).
