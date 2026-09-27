---
description: "Fix common Jazz problems: rejected provider keys, a local model that never answers, empty replies, missing tools, keyring errors, a stopped daemon, and where logs are."
---

# Troubleshooting

Start with the three checks below, then find the symptom.

```bash
jazz config validate    # names every setting Jazz rejects, and suggests the one you meant
jazz config show        # the configuration Jazz actually resolved
jazz --debug <command>  # the same command, logging at debug level
```

## Where the logs are

Everything is under `~/.jazz/logs` (or `$JAZZ_HOME/logs`, or `$JAZZ_LOG_DIR` when set).

| File                                         | Holds                                                       |
| -------------------------------------------- | ----------------------------------------------------------- |
| `jazz.log`                                   | Everything not tied to one conversation                     |
| `<conversation-id>.log`                      | One conversation or run: model requests, tool calls, errors |
| `<workflow>.log`, `<workflow>.error.log`     | Output of a scheduled workflow                              |
| `reminder-<id>.log`, `wake-trigger-<id>.log` | Output of a one-shot reminder or wake-up                    |

Set `logging.level` to `debug` in `~/.jazz/config.json` to keep debug logging on, and
`logging.format` to `json` for one object per line. `--verbose` only adds detail to
`jazz agent list`; it does not change what is logged.

## The provider rejects the key

The message names the provider, for example "OpenAI API key is missing or invalid".

1. Check the agent uses the provider you think it does: `jazz agent show <agent>`.
2. Save the key again without putting it in your shell history. `jazz config set openai`
   prompts for it; replace `openai` with your provider.
3. Or export the provider's variable instead, such as `OPENAI_API_KEY`. A saved key wins over
   the variable, so remove a stale saved key if the variable seems ignored. The variables are
   listed in [Environment variables](./configure/environment-variables.md#model-provider-keys-and-servers).
4. A pasted key with a stray space or newline is rejected like a wrong one. Paste it again.

## A local model never answers

The run waits, then fails with "Provider stream produced no first part for 120s and was
abandoned".

- **Check the server from the machine Jazz runs on**, not from your laptop when Jazz runs
  elsewhere: `curl http://127.0.0.1:11434/api/tags` for Ollama,
  `curl http://127.0.0.1:8080/v1/models` for llama.cpp.
- **Check the address Jazz uses.** A saved `llm.ollama.base_url` (or `llamacpp`, `vllm`,
  `sglang`) wins over `OLLAMA_BASE_URL` and the other variables. Change it under
  **Update configuration** → **LLM Providers** in the `jazz` home menu.
- **A large model loading from disk** can take longer than two minutes before its first
  word. Raise `llm.streamIdleTimeoutMs` (or `JAZZ_STREAM_IDLE_TIMEOUT_MS`), and set
  `llm.ollama.keep_alive` to `30m` or `-1` so Ollama keeps the model loaded between runs.
- **"No models found"** means Ollama has nothing pulled: run `ollama pull <model>`.
- **"The server … rejected the request (401)"** means the server was started with an API key:
  set `llm.<provider>.api_key`, or run `jazz agent create` again, which asks for it.

[Local and air-gapped models](./getting-started/local-models.md) covers setup, and
[Diagnose provider failures](./configure/providers.md#diagnose-provider-failures) covers
tool-call problems on llama.cpp, vLLM and SGLang.

## The answer is empty

Jazz warns "model returned an empty response" when the model sent no text, no reasoning and
no tool call.

- A local model with too small a context window often stops answering once the conversation
  grows. Set `numCtx` on the agent to a value the server can hold, or start a new
  conversation.
- A provider's safety filter can end an answer with nothing in it. The conversation log
  records how the request finished.
- Try the same prompt with another model to tell a model problem from a Jazz one.

## The agent has no tools

Jazz sends tools only to models it knows can call them. A model the catalog does not list,
such as one released this week, gets none, and the log says
"Tools skipped because model does not support tools".

- If the model does call tools, declare it:
  `jazz config set 'llm.capabilityOverrides.<provider>."<model-id>".supportsTools' true`.
  See [Model capability overrides](./configure/providers.md#model-capability-overrides).
- With `JAZZ_OFFLINE` set and no cached catalog, no cloud model is known. Run Jazz once online,
  or see [Model catalog options](./getting-started/local-models.md#model-catalog-options).
- A persona or `deniedTools` may leave a tool out on purpose. `/tools` in a chat lists what
  the agent actually has.

## Secrets will not save

Jazz stores secrets in macOS Keychain or, on Linux, the Secret Service (`secret-tool`). A
Linux machine without a desktop session usually has no Secret Service; Jazz then uses
`~/.jazz/secrets.json`, readable only by you.

- "`$JAZZ_DISABLE_KEYRING` is set, so Jazz won't store this token anywhere" means exactly
  that: unset the variable, or supply the secret as an environment variable.

## The daemon is not running

Goals, loops and in-process schedules need `jazz daemon`. Check that it answers:

```bash
curl http://127.0.0.1:4747/health    # {"ok":true,...} when it is up
```

- Started by hand, it runs in the background and prints nothing. Run
  `jazz daemon --foreground` to watch it, and `jazz daemon stop` to stop it.
- Installed as a service with `jazz daemon install`, it logs to the system:
  `journalctl -u jazz-daemon -n 50 --no-pager` on Linux,
  `log show --predicate 'process == "jazz"' --last 5m` on macOS.
- A different port needs `--port` on every command that talks to it.

See [Daemon](./concepts/daemon.md).

## A scheduled workflow did not run

```bash
jazz workflow scheduled          # is it scheduled at all?
jazz workflow history <name>     # did it start?
```

Then read `~/.jazz/logs/<workflow>.log` and `<workflow>.error.log`. A workflow scheduled
with launchd or cron runs only while the machine is awake; the next interactive `jazz` offers
to catch up on runs it missed. With `scheduler.mode` set to `in-process`, nothing runs unless
the daemon is up. See [Scheduled runs](./surfaces/scheduled.md).

## Reporting a bug

Open an [issue](https://github.com/lvndry/jazz/issues) with `jazz --version`, your operating
system, the output of `jazz config validate`, and the relevant lines from the conversation's
log. Remove keys and personal content first: logs can contain both.
