---
description: "Build a mixed-model Jazz incident agent that understands screenshots, recordings, and video, then generates a stakeholder-ready visual summary."
---

# Turn incident evidence into a visual briefing with companion models

This tutorial builds an incident agent whose everyday reasoning stays on an inexpensive text model.
Specialists inspect screenshots, recordings, and screen captures; an image-generation companion
turns the verified timeline into a briefing card.

## 1. Configure the providers

Configure the primary provider and every provider used by a companion:

```bash
jazz config
```

Jazz discovers current model capabilities from its catalog. Provider and key options are in
[Model providers](../configure/providers.md).

## 2. Create the orchestrating agent

```bash
jazz agent create
```

Name it `incident-media-analyst`. Choose a fast, tool-capable model and the `coder` persona. Keep
file management and perception delegation available; remove capabilities this job does not need.

Agent files live in `~/.jazz/agents/`. Add the companion map to the new file, choosing model ids
from providers you configured:

```json
{
  "id": "incident-media-analyst",
  "name": "incident-media-analyst",
  "config": {
    "persona": "coder",
    "llm": {
      "provider": "openrouter",
      "model": "z-ai/glm-5.3-flash"
    },
    "companions": {
      "analyze:image": "openrouter/inclusionai/ling-3.0-flash-vl",
      "analyze:audio": "alibaba/qwen3.6-27b",
      "analyze:video": "openrouter/inclusionai/ling-3.0-flash-vl",
      "generate:image": "openrouter/google/gemini-3.1-flash-image"
    }
  }
}
```

Choose models that support each assigned input or output. Run
`jazz agent list --can image` to list models available through your configured
providers. A binding uses Jazz's provider name followed by the model id: direct
Google models use `gemini/...`, while Google models through OpenRouter use
`openrouter/google/...`.

Configure credentials for every provider named in the companion map.

## 3. Give it an end-to-end cross-media job

```bash
jazz agent chat incident-media-analyst
```

Then send:

```text
Correlate @/tmp/latency-dashboard.png, @/tmp/on-call-note.m4a, and
@/tmp/reproduction.mp4. Build one timeline, distinguish observed facts from
inference, and tell me which hypothesis to test first. Then generate a 16:9
incident briefing card with the confirmed timeline, impact, and next action.
```

The parent agent breaks the problem into precise media-analysis tasks. Each companion sees only its
assigned files and task; the parent reconciles the returned evidence, then sends only the approved
visual brief to the image-generation companion. This avoids putting the full conversation and
every attachment into every model call.

## 4. Run the same analyst in CI

Copy its JSON into the runner's Jazz home, expose only the provider keys it needs, and bind the
artifacts from your test job:

```yaml
- name: Explain visual regression failure
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    ALIBABA_API_KEY: ${{ secrets.ALIBABA_API_KEY }}
  run: |
    mkdir -p ~/.jazz/agents
    cp .github/jazz/agents/incident-media-analyst.json ~/.jazz/agents/
    jazz run --json --agent incident-media-analyst --approval-policy read-only \
      "Compare @${GITHUB_WORKSPACE}/artifacts/expected.png and @${GITHUB_WORKSPACE}/artifacts/actual.png. Explain the first meaningful divergence, then generate an annotated image that makes the regression obvious to the owning team." \
      > media-review.json
```

Adjust the keys if you chose different providers.
No picker appears in CI: the saved `analyze:image` binding is the decision. Parse
`media-review.json` only after checking `.ok` and `.costKnown`.

## Companion behavior

- The primary model remains the agent's identity and orchestrator.
- Companions have isolated context, no tools, and bounded execution.
- Analysis and generation can use different providers and models for the same medium.
- Unattended runs require a saved companion binding.
- Companion spend is included in the parent run's cost accounting.
