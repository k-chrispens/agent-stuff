# Claude Code Review Loop

An iterative review loop for Claude Code, ported from `pi-review-loop`. Claude reviews its own code (or plan) with fresh eyes, re-reviewing until no issues remain or the iteration cap is hit.

## Architecture

```
UserPromptSubmit hook                    Stop hook
        │                                   │
        ▼                                   ▼
  /review-* command?───yes──► write          load state-<SID>.json
        │                    pending              │
        no                                   active + not paused?
        │                                        │
  Case B forced────yes──► skip              read last assistant text
  continuation?                                  │
        │                                   exit phrase + no issues fixed?
        no                                  ───yes──► delete state, allow stop
        │                                        │
  auto-trigger?────yes──► write             iter+1 >= max?
                         delayed            ───yes──► delete state, allow stop
        │                pending                 │
  active loop?                              build prompt, update state
  ───yes──► interrupt                       emit {"decision":"block","reason":...}
            (pause/stop)
```

Both hooks invoke `~/.claude/hooks/review-loop.sh`. State is per-session (`state-<session_id>.json`), so concurrent Claude Code instances each run independent loops.

## Installation

```bash
./setup.sh
```

This creates:
- `~/.claude/hooks/review-loop.sh` — symlink to the hook script
- `~/.claude/review-loop/` — state directory (config, prompts, per-session state)
- Hook entries in `~/.claude/settings.json` for `Stop` and `UserPromptSubmit`

### Recommended permission rule

On first `/review-*` command, Claude Code will prompt for bash permission. To auto-approve:

```bash
jq '.permissions.allow += ["Bash(bash ~/.claude/hooks/review-loop.sh:*)"] | .permissions.allow |= unique' \
  ~/.claude/settings.json > ~/.claude/settings.json.tmp.$$ && \
  mv ~/.claude/settings.json.tmp.$$ ~/.claude/settings.json
```

## Commands

| Command | Description |
|---|---|
| `/review-start [focus]` | Start code review loop. Optional focus text is appended to the prompt. |
| `/review-plan [focus]` | Start plan/spec review loop. |
| `/review-pause` | Pause the active loop. |
| `/review-resume` | Resume a paused loop. |
| `/review-exit` | Stop the active loop. |
| `/review-status` | Show loop status and configuration. |
| `/review-max <N>` | Set max iterations (default: 7). |
| `/review-auto [on\|off\|toggle]` | Toggle auto-trigger on implementation prompts. |
| `/review-interrupt <pause\|stop>` | Set interrupt behavior when you type during a loop. |

## Configuration

`~/.claude/review-loop/config.json` — persistent, global (not per-session).

```json
{
    "max_iterations": 7,
    "auto_trigger": false,
    "interrupt_behavior": "pause",
    "exit_patterns_mode": "default",
    "issues_fixed_patterns_mode": "default",
    "custom_exit_patterns": [],
    "custom_issues_fixed_patterns": [],
    "custom_trigger_patterns": [],
    "prompt_code": null,
    "prompt_plan": null
}
```

| Field | Description |
|---|---|
| `max_iterations` | Maximum review passes before auto-stop (default 7). |
| `auto_trigger` | When true, prompts matching trigger patterns (e.g., "implement the plan") automatically start a review loop after Claude finishes the request. Disabled by default. |
| `interrupt_behavior` | `"pause"` (default) or `"stop"`. What happens when you send a message during an active loop. |
| `*_patterns_mode` | `"default"`, `"extend"` (append custom to defaults), or `"replace"` (custom only). |
| `custom_*_patterns` | Arrays of regex strings (ERE, case-insensitive). |
| `prompt_code` / `prompt_plan` | Override prompt file paths. `null` uses defaults. |

## How termination works

The loop terminates when the last assistant message satisfies:

```
hasExitPhrase AND NOT hasIssuesFixed
```

**Exit patterns** (any match → exit candidate):
- `no issues found`, `no bugs found`
- `looks good`, `all good`

**Issues-fixed patterns** (any match → override exit, continue loop):
- `issue(s) fixed`, `fixed the following/these/this/issues/bugs`
- `found and fixed/corrected/resolved`
- `changes made`, `here's what I fixed/changed`
- `issues:`, `bugs:`, `problems:`, `changes:`, `fixes:`
- `ready for another review`

This catches cases like "I fixed 3 issues. No issues found." where the model fixed things and should get one more review pass.

## State files

### `state-<session_id>.json`

Per-session loop state. Deleted on clean deactivation; absence means "inactive".

```json
{
    "active": true,
    "paused": false,
    "iteration": 1,
    "kind": "code",
    "focus": "focus on error handling",
    "session_id": "abc123-...",
    "cwd": "/path/to/project",
    "started_at": 1712345678,
    "last_updated": 1712345680,
    "last_block_at": 1712345680,
    "last_block_reason": "..."
}
```

TTL: 2 hours from `last_updated`. Stale files are auto-deleted.

### `pending-<session_id>.json`

Short-lived marker created by UserPromptSubmit when it sees a `/review-*` command or auto-trigger. TTL: 5 minutes.

## Auto-trigger

When `auto_trigger` is enabled, prompts matching patterns like "implement the plan", "implement the spec", "let's implement", etc. schedule a review loop to auto-activate after Claude finishes the request. The loop starts on the next Stop event, not immediately.

**Semantic difference from pi:** pi counts the user's response to the trigger prompt as review pass 1. Claude Code separates them: implementation first, then review. Both result in the same final state.

## Differences from pi-review-loop

| Feature | pi | Claude Code |
|---|---|---|
| Fresh-context mode | Supported (transcript surgery) | Not feasible — Claude Code has no transcript surgery API |
| `/review-auto <focus>` shortcut | Sets auto-trigger + starts with focus | `/review-auto` is strictly on/off/toggle; use `/review-start <focus>` |
| Auto-trigger turn packing | Implementation + review in one turn | Separate turns |
| Config persistence | Session-scoped | Global (`config.json`) |
| Agent-callable tool | MCP-style `review_loop` tool | Deferred (skills cover user-facing cases) |

## Debugging

```bash
# Watch hook activity
tail -f ~/.claude/review-loop/hook.log

# List active sessions
ls ~/.claude/review-loop/state-*.json

# Inspect a session's state
jq . ~/.claude/review-loop/state-<session_id>.json

# Verify hook registration
jq '.hooks' ~/.claude/settings.json

# Run the selftest (uses a tempdir, safe)
bash ~/.claude/hooks/review-loop.sh selftest

# Check config
jq . ~/.claude/review-loop/config.json
```

## Known limitations

- **Case B (forced continuations):** It is unknown whether UserPromptSubmit fires on Stop-injected continuations. Two mitigations are in place: content matching (compares prompt to last block reason) and time-based (2-second window). If the loop pauses unexpectedly after one iteration, Case B handling may need tuning.

- **Two concurrent sessions in the same directory:** Control subcommands (`/review-*`) use a heuristic to find the session ID via pending files. If two `claude` instances run in the same directory, the heuristic may pick the wrong session. Use different directories or run one loop at a time.

- **PCRE patterns on macOS:** Two issues-fixed patterns use lookbehind (`(?<!no\s)`) which requires PCRE grep. On macOS without `ggrep` (GNU grep), a fallback two-pass sanitization is used. Install GNU grep via `brew install grep` for exact pattern matching.

## Dependencies

- `jq` (hard requirement)
- Bash 3.2+ (macOS default; no bash 4+ features used)
- Standard POSIX tools: `awk`, `sed`, `find`
- `tail -r` (macOS) or `tac` (Linux) for transcript parsing
