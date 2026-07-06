---
name: zmx
description: "Use pi-zmx/zmx for persistent terminal sessions, long-running commands, and human-in-the-loop interactive CLIs."
---

# zmx Skill

Use `zmx` through the `pi-zmx` tools instead of hand-rolled `tmux` control.

## When to use

- Persistent shell state across calls: exported env vars, cwd changes, background services.
- Long-running commands you may need to inspect later.
- Interactive commands that need a human to attach: `sudo`, password prompts, `vim`, debuggers, REPLs.
- Subagents/worker agents: run every spawned `pi`, Claude Code, Amp, or Codex worker inside its own named zmx session.

## Subagents and workers

Never background a subagent with bare `&`, `nohup`, or an ad-hoc terminal multiplexer. Use zmx so the human and coordinator can attach, inspect scrollback, recover after disconnects, and kill the worker cleanly.

```bash
zmx run worker-name -d sh -lc 'cd /path/to/worktree && exec pi "/name worker-name" "Do the task"'
zmx history worker-name
zmx attach worker-name
zmx kill worker-name --force
```

Name sessions after the task (`issue-42`, `review-api`, `benchmarks`) so `list_sessions` / `send_to_session` can coordinate with the agent once it has set `/name`.

## Pi tools

- `zmx_run(command=[...], session="name", timeout=30)` — run one argv-array command in a persistent session. No shell wrapper; use `['sh', '-c', 'cmd && other']` when you need shell syntax.
- `zmx_history(session="name", lines=100)` — inspect recent output/scrollback.
- `zmx_list()` — list sessions.
- `zmx_kill(sessions=["name"], force=true)` — clean up sessions.
- `zmx_attach(session="name")` — tell the human how to attach for interactive input.
- `zmx_wait(session="name")` — wait when using async/background zmx workflows.

If no `session` is provided, `pi-zmx` uses the Pi session display name when available. Otherwise pass a short explicit name.

## CLI reference

`zmx` itself provides:

```bash
zmx attach <name> [command...]     # create/attach to a session
zmx run <name> [command...]        # send a command without attaching
zmx send <name> <text...>          # raw PTY input
zmx history <name> [--vt|--html]   # scrollback
zmx list --short                   # sessions
zmx kill <name>... --force         # cleanup
```

Detach by closing the terminal, pressing `Ctrl+\\`, or running `zmx detach`.

## Human-in-the-loop pattern

1. Start the command: `zmx_run(command=["sudo", "apt", "update"], session="server")`.
2. If it needs input, call `zmx_attach(session="server")` and ask the human to complete it.
3. Inspect with `zmx_history(session="server")`.

## Install notes

`pi-zmx` is installed by this repo's `./setup.sh`. The `zmx` binary must also be on `PATH`:

```bash
brew install neurosnap/tap/zmx
```

Other binaries are at <https://zmx.sh/#binaries>.
