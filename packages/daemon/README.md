# `@jazz/daemon`

The Jazz daemon: the long-running process behind `jazz daemon` that serves the
authenticated HTTP API and does work nobody is watching, on a tick.

Depends on `@jazz/core` and `@jazz/adapters`. Nothing below it imports it: adapters, core, and
the bot packages stay daemon-free, which an eslint rule and `scripts/package-layering.test.ts`
enforce. A piece the CLI also needs without a daemon (resuming a goal or loop run, the in-flight
run set) lives in `@jazz/adapters` (`goals/`, `loops/`, `runs/`) instead.

## Key files

- **`server.ts`**: the HTTP server: operator routes, webhooks, remote doors, peer ask and peer
  invites, and the bearer-token checks in front of them.
- **`trigger-runner.ts`**: one tick of due workflow schedules, wake triggers, reminders, and
  background jobs; each claim is forked so a long run never delays the rest.
- **`job-worker.ts`**: runs queued background job batches and resumes the conversation when a
  batch finishes.
- **`unattended-resume.ts`**: one agent turn on an existing conversation with nobody at the
  keyboard, for a wake trigger or a finished job batch, and how that turn ended.
- **`attention.ts`**: what is waiting on the operator, whether the daemon may start work (it
  pauses at a daily spend cap), and queueing notifications about both.
- **`token.ts`**, **`operator-token.ts`**: the keyring-backed daemon and operator tokens.
- **`credential-cache.ts`**: remembers door credentials briefly so a request does not read the
  keyring once per configured peer.
- **`daemon-status.ts`**: the status record the daemon writes every tick, read by
  `jazz daemon status`.
- **`service-install.ts`**: installs and removes the system-level launchd/systemd service.

The goal and loop tick loops (`runDueGoals`, `runDueLoops`) live beside their cycle runners in
`@jazz/adapters/goals/goal-worker` and `@jazz/adapters/loops/loop-worker`, since answering a
parked goal or loop run from the CLI settles the cycle through the same code.

## Related documentation

- **Daemon concepts**: `docs/concepts/daemon.md`
- **Adapters**: `packages/adapters/README.md`
- **Code map**: `docs/maintainers/architecture.md`
