# Agent Stuff

This repository contains Pi skills, extensions, themes, and a few supporting helper scripts that I use across projects. Most of it is tuned for my own workflows, so expect to adapt pieces for your own setup.

This repo is also published on npm as `mitsupi`, but the current repository layout is optimized for direct local use via `./setup.sh`.

## Local setup

For day-to-day use from this repository, run:

```bash
./setup.sh
```

That script:

- links `global/extensions/` into `~/.pi/agent/extensions`
- links `skills/` into `~/.pi/agent/skills`
- merges this repo's project-local extensions from `.pi/extensions/` into Pi settings
- installs npm dependencies for `.pi/extensions/`
- removes the deprecated `npm:pi-review-loop` package entry so the bundled repo version is used instead
- links `global/CLAUDE.md` into `~/.claude/CLAUDE.md` when Claude Code or Amp is installed
- links individual skills into `~/.claude/skills/` when Amp is installed

## Repository layout

- [`global/extensions`](global/extensions) - repo-global Pi extensions, loaded via `~/.pi/agent/extensions`
- [`.pi/extensions`](.pi/extensions) - project-local Pi extensions plus their shared dependencies
- [`skills`](skills) - reusable Pi/agent skills
- [`pi-themes`](pi-themes) - Pi themes
- [`plumbing-commands`](plumbing-commands) - command templates that need per-repo customization
- [`intercepted-commands`](intercepted-commands) / [`pixi-intercepted-commands`](pixi-intercepted-commands) - command shims used by the Python workflow extensions

## Skills

Available skills in [`skills`](skills):

- [`/commit`](skills/commit) - create clean Conventional Commit messages
- [`/github`](skills/github) - interact with GitHub through the `gh` CLI
- [`/github-issues`](skills/github-issues) - structured issue triage and implementation workflow using worktrees
- [`/learning-mode`](skills/learning-mode) - structured AI-assisted learning workflow
- [`/mermaid`](skills/mermaid) - create and validate Mermaid diagrams
- [`/native-web-search`](skills/native-web-search) - web search via Anthropic or OpenAI Codex models with source URLs
- [`/pymol-pml-scripting`](skills/pymol-pml-scripting) - generate correct PyMOL `.pml` scripts for molecular visualization
- [`/svg`](skills/svg) - create and validate SVG files
- [`/tmux`](skills/tmux) - drive tmux sessions programmatically
- [`/uv`](skills/uv) - use `uv` for Python environments, dependencies, and scripts
- [`/web-browser`](skills/web-browser) - browser automation via Chrome DevTools Protocol

## Pi extensions

This repo currently uses two extension locations:

- [`global/extensions`](global/extensions) - repo-global extensions linked into `~/.pi/agent/extensions` by `./setup.sh`
- [`.pi/extensions`](.pi/extensions) - project-local extensions and shared extension dependencies used when working inside this repo

### Global extensions

- [`pi-review-loop`](global/extensions/pi-review-loop) - persistent automated self-review loop for Pi. Supports pause/resume on interruption, resumes after steering or follow-up user messages, survives compaction, and is bundled directly in this repo instead of being installed through `pi install npm:pi-review-loop`.
- [`auto-commit-on-exit.ts`](global/extensions/auto-commit-on-exit.ts) - creates a git commit automatically when a session exits
- [`dirty-repo-guard.ts`](global/extensions/dirty-repo-guard.ts) - blocks risky session actions when the repo has uncommitted changes
- [`git-checkpoint.ts`](global/extensions/git-checkpoint.ts) - creates git stash checkpoints during work for safer restores and branching

### Project-local extensions

- [`answer.ts`](.pi/extensions/answer.ts) - interactive TUI for answering questions one by one
- [`context.ts`](.pi/extensions/context.ts) - quick context breakdown (extensions, skills, AGENTS/CLAUDE docs) plus token usage
- [`control.ts`](.pi/extensions/control.ts) - session-control helpers for inter-session communication
- [`files.ts`](.pi/extensions/files.ts) - unified file browser with git status and session references
- [`loop.ts`](.pi/extensions/loop.ts) - prompt loop for iterative coding with breakout signaling
- [`notify.ts`](.pi/extensions/notify.ts) - desktop/webhook notifications when the agent finishes
- [`pdf-reader`](.pi/extensions/pdf-reader) - reads PDFs and extracts text plus embedded figures
- [`pixi.ts`](.pi/extensions/pixi.ts) - Pixi-aware Python workflow helpers
- [`review.ts`](.pi/extensions/review.ts) - Codex-style code review command for branches, commits, PRs, folders, and custom instructions
- [`session-breakdown.ts`](.pi/extensions/session-breakdown.ts) - interactive session usage and cost breakdown UI
- [`todos.ts`](.pi/extensions/todos.ts) - file-backed todo manager with TUI helpers
- [`uv.ts`](.pi/extensions/uv.ts) - uv-aware Python workflow helpers
- [`vim.ts`](.pi/extensions/vim.ts) - Vim-style editing helpers for the Pi interface
- [`whimsical.ts`](.pi/extensions/whimsical.ts) - replaces the default thinking message with whimsical status text

## Notify webhook fallback setup

Set these environment variables before starting Pi. The notify extension auto-detects Slack/ntfy/Pushover URLs when `PI_NOTIFY_WEBHOOK_KIND` is unset or `auto`.

```bash
# Common options (optional)
export PI_NOTIFY_WEBHOOK_TIMEOUT_MS=5000
export PI_NOTIFY_WEBHOOK_ALWAYS=1  # send webhook even if terminal notifications succeed
```

### Slack incoming webhook

```bash
export PI_NOTIFY_WEBHOOK_URL="https://hooks.slack.com/services/T000/B000/XXXX"
export PI_NOTIFY_WEBHOOK_KIND=slack
export PI_NOTIFY_SLACK_USERNAME="Pi"
export PI_NOTIFY_SLACK_ICON_EMOJI=":robot_face:"
```

### ntfy

```bash
export PI_NOTIFY_WEBHOOK_URL="https://ntfy.sh/your-topic"
export PI_NOTIFY_WEBHOOK_KIND=ntfy
# Optional for private topics:
export PI_NOTIFY_WEBHOOK_BEARER_TOKEN="tk_xxxxxxxxxx"
```

### Pushover

```bash
export PI_NOTIFY_WEBHOOK_URL="https://api.pushover.net/1/messages.json"
export PI_NOTIFY_WEBHOOK_KIND=pushover
export PI_NOTIFY_PUSHOVER_TOKEN="your-app-token"
export PI_NOTIFY_PUSHOVER_USER="your-user-key"
# Optional:
export PI_NOTIFY_PUSHOVER_PRIORITY=0
```

For custom endpoints, leave `PI_NOTIFY_WEBHOOK_KIND` as `auto`/unset (or set `generic`) to send a JSON payload with `title`, `body`, `channel`, `timestamp`, `host`, and `cwd`.

## Pi themes

Available themes in [`pi-themes`](pi-themes):

- [`nightowl.json`](pi-themes/nightowl.json) - custom Night Owl-inspired Pi theme

## Plumbing commands

These command files need customization before use. They live in [`plumbing-commands`](plumbing-commands):

- [`/make-release`](plumbing-commands/make-release.md) - repository release helper template

## Notes

- The repo-bundled review loop now lives at `global/extensions/pi-review-loop`.
- If you previously installed `pi-review-loop` through Pi's package manager, `./setup.sh` removes that package reference from Pi settings so the repo version wins.
- `.pi/extensions/package.json` contains the shared runtime dependencies used by the project-local extensions.
