# Plan: Port pi-review-loop to Claude Code

## Goal

Bring the full pi-review-loop experience to Claude Code using hooks. The user uses this frequently in pi and wants parity — this is **not an MVP**, so every feature that is technically portable to Claude Code must be ported with matching behavior.

## Features to port (from `global/extensions/pi-review-loop`)

| pi feature                                       | Portable?                                 | In this plan |
|--------------------------------------------------|-------------------------------------------|-------------|
| Iterative review loop (Stop → re-inject)          | Yes (`Stop` hook)                         | ✓           |
| Code vs plan review prompt                       | Yes                                        | ✓           |
| Custom focus text                                | Yes                                        | ✓           |
| Max iterations (default 7)                       | Yes                                        | ✓           |
| Exit detection with regex + issues-fixed counter | Yes                                        | ✓           |
| Auto-trigger from keyword patterns               | Yes (`UserPromptSubmit` hook)             | ✓           |
| Interrupt behavior (pause / stop)                | Yes (`UserPromptSubmit` hook)             | ✓           |
| Pause / resume                                   | Yes                                        | ✓           |
| Persistent user preferences                      | Yes (separate `config.json`)              | ✓           |
| Survive session compaction                       | Yes (state file on disk, robust prompts)  | ✓           |
| Fresh-context mode (strip prior iterations)      | **No** — Claude Code has no transcript surgery API | Out of scope, documented |
| Agent-callable tool (`review_loop`)              | Deferred — skills cover user-facing cases; MCP server later if needed | Deferred |

## How pi's termination works (must match exactly)

The loop terminates when the last assistant text satisfies:

```
hasExitPhrase AND NOT hasIssuesFixed
```

- **`exitPatterns`** (case-insensitive, matches: `no issues found`, `no more issues found`, `no bugs found`, `looks good`, `all good`):
  - `/no\s+(\w+\s+)?issues\s+found/i`
  - `/no\s+(\w+\s+)?bugs\s+found/i`
  - `/(?:^|\n)\s*(?:looks\s+good|all\s+good)[\s.,!]*(?:$|\n)/im`
- **`issuesFixedPatterns`** (counter patterns — if any match, DO NOT terminate, even if an exit phrase matched; this catches "I fixed 3 issues. No issues found." where the model fixed things this pass and should get one more review):
  - `/issues?\s+(i\s+)?fixed/i`
  - `/fixed\s+(the\s+)?(following|these|this|issues?|bugs?)/i`
  - `/fixed\s+\d+\s+issues?/i`
  - `/found\s+and\s+(fixed|corrected|resolved)/i`
  - `/bugs?\s+(i\s+)?fixed/i`
  - `/corrected\s+(the\s+)?(following|these|this)/i`
  - `/(?<!no\s)issues?\s+(i\s+)?(found|identified|discovered)/i`
  - `/(?<!no\s)problems?\s+(i\s+)?(found|identified|discovered)/i`
  - `/changes?\s+(i\s+)?made/i`
  - `/here'?s?\s+what\s+(i\s+)?(fixed|changed|corrected)/i`
  - `/(issues|bugs|problems|changes|fixes)\s*:/i`
  - `/ready\s+for\s+(another|the\s+next)\s+review/i`

These regexes are copied verbatim from `global/extensions/pi-review-loop/settings.ts`. They must be embedded in `hook.sh` via `grep -E` (ERE, case-insensitive with `-i`). The Perl-only `(?<!...)` lookbehind in two patterns requires `grep -P` (PCRE). On macOS, BSD grep lacks `-P`; the hook must either use `ggrep` (GNU grep) if available, or fall back to a two-pass check that strips `no ` prefixes before matching.

**Implementation note:** do NOT replace these regexes with simpler substring checks. Pi's current behavior depends on them. The plan was previously wrong about this.

## Auto-trigger patterns (must match exactly)

From pi's `DEFAULT_TRIGGER_PATTERNS`, all case-insensitive:
- `/\bimplement\s+(the\s+)?plan\b/i`
- `/\bimplement\s+(the\s+)?spec\b/i`
- `/\bimplement\s+(this\s+)?plan\b/i`
- `/\bimplement\s+(this\s+)?spec\b/i`
- `/\bstart\s+implementing\b.*\b(plan|spec)\b/i`
- `/\bgo\s+ahead\s+and\s+implement\b.*\b(plan|spec)\b/i`
- `/\blet'?s\s+implement\b.*\b(plan|spec)\b/i`
- `/\b(plan|spec)\b.*\bstart\s+implementing\b/i`
- `/\b(plan|spec)\b.*\bgo\s+ahead\s+and\s+implement\b/i`
- `/\b(plan|spec)\b.*\blet'?s\s+implement\b/i`
- `/read over all of the new code.*fresh eyes/i`

Auto-trigger is **disabled by default**. User enables via `/review-auto on`.

## Architecture

Two hooks and a shared state directory. **State and pending files are per-session** so multiple concurrent Claude Code sessions can each run their own loop independently:

```
~/.claude/
├── hooks/
│   └── review-loop.sh                 # symlink → global/claude-review-loop/hook.sh
├── review-loop/
│   ├── config.json                    # persistent user preferences (global)
│   ├── state-<session_id>.json        # per-session activation state
│   ├── pending-<session_id>.json      # per-session pre-activation marker
│   ├── prompts/                       # symlink → global/claude-review-loop/prompts
│   │   ├── code.md                    # symlink → ../../extensions/pi-review-loop/prompts/double-check.md
│   │   └── plan.md                    # symlink → ../../extensions/pi-review-loop/prompts/double-check-plan.md
│   └── hook.log                       # append log, capped at 1MB with rotate-to-.1
└── settings.json                      # adds .hooks.Stop and .hooks.UserPromptSubmit entries
```

Why per-session: pi's loop is per-session by nature (state lives in the session store). To match, we key state files by `session_id` so running two `claude` instances in the same project (or in different projects) each has its own loop. A singleton state file would make the last-activated session kill the earlier one's loop — a silent regression.

Both hooks invoke **the same script** (`review-loop.sh`) with no arguments; the script reads stdin JSON and branches on `hook_event_name`. The script is also invoked with explicit subcommands by the skill bodies (`activate`, `pause`, `resume`, etc.). It dispatches based on `$#`:

```
hook.sh                        # no args → hook mode, read stdin
hook.sh activate <kind> [focus]
hook.sh deactivate
hook.sh pause
hook.sh resume
hook.sh status
hook.sh max <N>
hook.sh auto <on|off|toggle>
hook.sh interrupt <pause|stop>
hook.sh selftest                # canned input for CI/manual testing
```

### Event flow (code review, happy path)

```
1. User: /review-start focus on error handling
   ↓
2. UserPromptSubmit hook fires
   - stdin JSON: {session_id: SID, transcript_path, cwd, hook_event_name, prompt}
   - Detects prompt starts with "/review-start"
   - Parses focus text: "focus on error handling" (everything after the command name)
   - Writes pending-<SID>.json with {session_id: SID, cwd, created_at: now,
     delayed: false, kind: "code", focus: "focus on error handling"}
   - Outputs nothing → allows prompt through
   ↓
3. Claude Code loads skills/review-start/SKILL.md, injects body
   ↓
4. Claude runs: bash ~/.claude/hooks/review-loop.sh activate code
   (No env var needed — the skill body instructs Claude NOT to extract focus,
   since UserPromptSubmit already parsed it into the pending file.)
   - resolve_session_id() scans pending-*.json for cwd==$PWD, finds pending-SID.json,
     returns SID
   - cmd_activate reads REVIEW_LOOP_FOCUS (empty), falls back to pending.focus
     = "focus on error handling"
   - activate_core(SID, $PWD, "code", "focus on error handling") writes
     state-SID.json: {active: true, paused: false, iteration: 0, kind: "code",
     focus: "focus on error handling", session_id: SID, cwd, started_at,
     last_updated, last_block_at: 0, last_block_reason: ""}
   - Prints the review prompt (read from prompts/code.md, frontmatter stripped,
     focus text appended with pi's "**Additional focus:** ..." format)
   ↓
5. Claude reads the printed prompt and begins review pass 1
   ↓
6. Claude's turn ends → Stop hook fires
   - stdin JSON: {session_id: SID, transcript_path, cwd, hook_event_name: "Stop",
     stop_hook_active}
   - Loads state-SID.json; active=true, cwd matches → proceed
   - Reads last assistant text from transcript_path
   - Text is non-empty, doesn't match exitPatterns (or matches with issues-fixed) → continue
   - iteration 0 < max 7 → increment to 1, update last_block_at, persist, emit
     {"decision":"block","reason":"<review prompt>"}
   ↓
7. Claude is forced to continue → review pass 2
   ↓
8. ... iterations continue ...
   ↓
9. Eventually Claude's last text matches exitPatterns AND not issuesFixedPatterns
   → Stop hook deletes state-SID.json, exits 0 (no JSON), stop is allowed
```

### Event flow (interrupt by non-loop user message)

```
1. Loop is active for session SID, waiting for next iteration (paused=false).
   Clock shows ≥2 seconds since state.last_block_at AND the incoming prompt
   does NOT match state.last_block_reason (otherwise Case B mitigation would
   fire and skip interrupt handling).
   ↓
2. User submits a non-loop prompt: "Actually, focus on the auth code"
   ↓
3. UserPromptSubmit hook fires
   - Loads state-SID.json; active=true
   - Prompt != state.last_block_reason AND now - last_block_at ≥ 2 → not a forced continuation
   - Prompt does not start with /review-*
   - auto_trigger=false (or trigger pattern doesn't match) → skip trigger-skip
   - Apply interrupt behavior from config.json:
     - "pause" (default): set state.paused=true, update last_updated
     - "stop":  delete state-SID.json
   - Outputs nothing → allows prompt through
   ↓
4. Claude responds to the new prompt → Stop hook fires
   - state.paused=true (or state file absent) → allow stop, do not block
   ↓
5. User later runs /review-resume
   - UserPromptSubmit hook sees /review-resume prefix, writes pending-SID.json, exits
   - Skill body runs hook.sh resume → resolve_session_id finds pending-SID,
     loads state-SID.json, clears paused, prints current review prompt
   - Claude reads the output and performs the review → Stop hook fires → loop resumes
```

### Event flow (auto-trigger)

```
1. config.auto_trigger=true, no state file exists for session SID
2. User: "Great, now implement the plan"
   ↓
3. UserPromptSubmit hook fires
   - No state-SID.json → state is empty
   - Prompt doesn't start with /review-*
   - auto_trigger=true AND state empty AND matches_trigger(prompt)==true
   - Writes pending-SID.json: {session_id: SID, cwd, created_at: now,
     delayed: true, kind: "code"}
   - Prints notice to stdout: "[INTERNAL NOTE, do not mention in reply:
     Review loop will auto-activate after this response. Complete the
     user's request first; a review pass will begin automatically.]"
   - Exits 0
   ↓
4. Claude sees the notice in its context, completes the user's request
   ↓
5. Stop hook fires
   - Loads pending-SID.json; delayed=true → promotion branch
   - Calls activate_core(SID, cwd, "code", "") → creates state-SID.json
   - Deletes pending-SID.json
   - Proceeds with normal block logic: iteration 0 < max → increment,
     emit {"decision":"block","reason":"<review prompt>"}
   ↓
6. Review loop begins normally
```

**Semantic difference from pi (documented in README):** pi's `before_agent_start` handler marks the *current* user turn as "review pass 1" via `awaitingReviewTurn=true`, so the user's original response to their trigger prompt counts as the first review pass. Pi's iteration count therefore reflects "number of review passes performed", where pass 1 is the user's own response to their trigger prompt.

Claude Code's version activates with `iteration=0`, and the *next* Stop (after the user's response to the trigger prompt) emits the first explicit review prompt as pass 1. So pi's auto-trigger does `implementation+review` as one turn; Claude Code's does `implementation` then `review` as separate turns. Both result in the same final state (N review iterations until clean or max), but the numbering and turn-packing differ.

This difference is intrinsic to the hook model — Claude Code's UserPromptSubmit stdout injection can add context to the upcoming turn but cannot cleanly signal "this turn counts as iteration 1 of a loop". Matching pi exactly would require adding `"After completing this request, also perform a fresh-eyes review per [prompt]"` to the UserPromptSubmit stdout, which is possible but makes the triggering turn much longer and harder to reason about. The simpler separated-turns design is chosen intentionally.

## Command surface (slash commands / skills)

Match pi's naming exactly for muscle-memory parity. Claude Code's builtin `/review` is a one-shot command; our `/review-start` is distinct enough to avoid shadowing.

| Skill               | Does what                                                          |
|---------------------|--------------------------------------------------------------------|
| `/review-start`     | Activate code review loop; body: run `hook.sh activate code [focus]`; Claude starts reviewing from the output |
| `/review-plan`      | Activate plan review loop; body: run `hook.sh activate plan [focus]`; Claude starts reviewing |
| `/review-pause`     | Run `hook.sh pause`                                                 |
| `/review-resume`    | Run `hook.sh resume` (prints current prompt; Claude performs review) |
| `/review-exit`      | Run `hook.sh deactivate` (named `exit` to match pi)                 |
| `/review-status`    | Run `hook.sh status`                                                |
| `/review-max`       | Run `hook.sh max <N>` (Claude extracts N from user prompt)          |
| `/review-auto`      | Run `hook.sh auto <on|off|toggle>`                                  |
| `/review-interrupt` | Run `hook.sh interrupt <pause|stop>`                                |

Not included (match pi's "out of scope" decision):
- `/review-fresh` — fresh context mode is not feasible in Claude Code (no transcript surgery). Documented in README.

### Focus-text argument passing

Claude Code skill bodies do not receive `$ARGUMENTS` substitution (unlike `.claude/commands/*.md` files — skills use a different rendering path). The skill body instructs Claude to:

> Extract any text the user wrote after the slash command name. If present, export it as `REVIEW_LOOP_FOCUS` in the shell environment before running the bash command. If absent, do not set the variable.

The hook reads the focus from the env var rather than `$2`. Using an env var sidesteps shell-quoting hazards when the focus text contains quotes, backticks, dollar signs, or newlines — Claude only has to write a single-quoted bash assignment, which is trivially correct for any content (single quotes are escaped as `'\''`).

Invocation pattern the skill body shows Claude:

```bash
REVIEW_LOOP_FOCUS='focus on error handling' bash ~/.claude/hooks/review-loop.sh activate code
```

Alternative considered: use `.claude/commands/*.md` instead of skills, which do support `$ARGUMENTS`. Rejected because the setup.sh already links skills from `skills/`, and splitting into two locations adds complexity. Revisit if the env-var approach proves unreliable.

**Not dropping pi's `/review-auto <focus-text>` shortcut intentionally:** pi lets the user type `/review-auto focus on error handling` to enable auto-trigger AND immediately start a review with that focus. Claude Code's version keeps `/review-auto` strictly for on/off/toggle; users wanting focus-text should use `/review-start focus on error handling` directly. Simplification documented in the README as the only user-visible behavioral delta from pi.

## Config file: `~/.claude/review-loop/config.json`

Persistent user preferences, global (not per-session). Survives `./setup.sh` re-runs (setup never touches this file after the first-run default write).

**Schema migration:** the hook's `read_config` merges the on-disk file against a compiled-in defaults object, so older configs missing newer fields keep working and pick up new defaults automatically. Malformed JSON falls back to defaults with a log warning.

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

- `max_iterations`: brake (pi default 7)
- `auto_trigger`: enables UserPromptSubmit auto-activation
- `interrupt_behavior`: `"pause"` or `"stop"`
- `*_patterns_mode`: `"default"` or `"extend"` (append to defaults) or `"replace"` (override defaults) — matches pi's `PatternConfig`
- `custom_*_patterns`: arrays of regex strings (no slashes, case-insensitivity is implicit)
- `prompt_code` / `prompt_plan`: optional paths to override prompts (null → use defaults)

The hook script reads this on every invocation (cheap, tens of bytes). If missing or malformed, defaults are used and a warning is logged.

## State file: `~/.claude/review-loop/state-<session_id>.json`

Per-session activation state. Deleted on clean deactivation; its absence means "inactive" for that session.

```json
{
  "active": true,
  "paused": false,
  "iteration": 1,
  "kind": "code",
  "focus": "focus on error handling",
  "session_id": "abc123-...",
  "cwd": "/Users/kyroyo/Projects/agent-stuff",
  "started_at": 1712345678,
  "last_updated": 1712345680,
  "last_block_at": 1712345680,
  "last_block_reason": "Great, now I want you to carefully read over..."
}
```

- `iteration`: starts at 0, incremented in the Stop hook BEFORE the max check (matching pi's agent_end order). After the Nth block is emitted, `iteration` equals N. Reflects the total number of review-prompt injections so far; `cmd_activate`'s initial prompt print does not itself increment this counter — the first Stop after that print does.
- `last_block_at`: unix-seconds timestamp of the last block emission; used as the backup check for Case B (forced-continuation) detection in UserPromptSubmit.
- `last_block_reason`: exact `reason` string of the last block emission; used as the primary check for Case B forced-continuation detection in UserPromptSubmit.
- `cwd` + `session_id`: used by guards to reject foreign events; `session_id` in the file must match the filename's embedded id (redundant but validated as a tamper check).

## Pending file: `~/.claude/review-loop/pending-<session_id>.json`

Per-session short-lived pre-activation marker. Created by UserPromptSubmit when it sees a `/review-*` command or an auto-trigger; consumed by either a control subcommand (for explicit `/review-*` commands) or the Stop hook (for auto-trigger promotion).

```json
{
  "session_id": "abc123-...",
  "cwd": "/Users/kyroyo/Projects/agent-stuff",
  "created_at": 1712345678,
  "delayed": false,
  "kind": "code",
  "focus": "focus on error handling"
}
```

- `delayed: false` = explicit slash command; consumed by the matching subcommand (activate/pause/resume/etc.)
- `delayed: true` = auto-trigger waiting for Stop; consumed by `handle_stop` which promotes it to state
- `focus` = focus text parsed by UserPromptSubmit from the `/review-start` or `/review-plan` prompt (the portion after the command name). Empty string for other commands or auto-triggers. `cmd_activate` uses this as a fallback when `REVIEW_LOOP_FOCUS` env var is empty — see the slash-command arg visibility contingency in the verification checklist for rationale.

TTL: 5 minutes. Any pending file older than that is treated as stale, deleted on the next hook invocation, and ignored. The 5-minute window accommodates Claude's asynchronous skill-body execution: between UserPromptSubmit writing the pending file and the skill's bash subcommand reading it, Claude may spend a noticeable amount of time analyzing the prompt, thinking, or running prior tool calls.

### How a control subcommand finds its session_id

Control subcommands (activate, pause, resume, status, etc.) are invoked from skill bodies by Claude running a bash command. At that point the script has no session_id on stdin — but `UserPromptSubmit` fired earlier in the same user turn with the real session_id, so a matching `pending-<session_id>.json` should exist.

Algorithm in `resolve_session_id` helper (single definition, used everywhere):

1. **Primary path — pending file scan.** List `~/.claude/review-loop/pending-*.json`, read each one, filter to those where `cwd == $PWD` AND `now - created_at < 300` (5-minute TTL). Pick the one with the most recent `created_at`. Extract `session_id` from the `.session_id` field of the JSON (not the filename, which may contain chars that don't roundtrip cleanly).
2. **Fallback — transcript cwd scan.** If the primary path finds nothing, fall through to the "Fallback when no pending file is found" algorithm below. This handles users who invoke `hook.sh` directly from scripts without a slash-command front-end.
3. **Final failure.** If both paths fail, print a clear error message to stderr and return non-zero. Do NOT store the message in a global variable like `RESOLVE_ERROR` — `resolve_session_id` is called via `$(...)` command substitution, which runs in a subshell, and globals set inside the subshell don't propagate to the caller. Printing directly to stderr is the only reliable way to surface the error.

Control subcommands do NOT delete the pending file after reading it — it expires via TTL. This allows multiple subcommand invocations within the same user turn, and also makes activate idempotent (re-running the skill body is safe).

## Prompt file strategy

To avoid duplicating pi's prompts, `global/claude-review-loop/prompts/` symlinks to pi's existing prompt files:

```
global/claude-review-loop/prompts/
  code.md -> ../../extensions/pi-review-loop/prompts/double-check.md
  plan.md -> ../../extensions/pi-review-loop/prompts/double-check-plan.md
```

The hook script reads `~/.claude/review-loop/prompts/<kind>.md` (itself a symlink installed by setup.sh), strips YAML frontmatter, strips the `$@` placeholder (which is a pi extension concept irrelevant here), trims, and appends focus text if present. Focus text format matches pi exactly:

```
<stripped prompt body>

**Additional focus:** <focus text>
```

Frontmatter stripping, leading-blank trimming, and trailing-blank trimming are all handled in a single awk pass inside `build_prompt` (see its pseudo-code below), followed by `sed 's/\$@//g'` to strip pi's `$@` placeholder. The awk only treats `---` at line 1 as the frontmatter opening delimiter, so a `---` horizontal rule in the prompt body is preserved.

## Transcript parsing

The hook reads `transcript_path` (from stdin JSON) to get the last assistant message text. Format is JSONL; each line is an event. Assistant events look like:

```json
{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "..."}, {"type": "thinking", "thinking": "..."}, {"type": "tool_use", ...}]}, ...}
```

Algorithm (`read_last_assistant_text`):

1. Detect reverse tool once at script start: `REVERSE=$(command -v tac || echo "tail -r")`. On macOS `tac` is absent but `tail -r` is present; on Linux `tac` is standard. If neither exists, fall back to `awk '{ lines[NR] = $0 } END { for (i = NR; i >= 1; i--) print lines[i] }'`.
2. Walk the transcript backward, up to a defensive cap of 500 lines.
3. For each line, use `jq` to extract text from assistant events:
   ```
   jq -r 'select(.type == "assistant") | (.message.content // []) | map(select(.type == "text") | .text) | join("\n")'
   ```
4. Return the first (most recent) non-empty result. This matches pi's `extractTextFromContent` which joins all text blocks in one assistant message with `\n`, while skipping assistant messages that contain only thinking or tool_use blocks.
5. If all scanned lines are empty, return empty string — `handle_stop` treats that as the abort/empty case and pauses the loop.

This correctly handles the edge cases observed in real transcripts:
- Assistant message with `contentTypes: ["thinking"]` only → skipped, walk continues
- Assistant message with `["text", "tool_use"]` → text extracted, tool_use ignored
- Multiple text blocks in one message → joined with `\n`
- Aborted turn with no assistant line at all → empty result → pause

## stop_hook_active handling and write failure safety

`stop_hook_active: true` means Claude Code is already in a forced continuation from a prior Stop hook block. Per Anthropic docs, not checking this flag risks infinite loops.

Our design uses two complementary brakes:

1. **Iteration counter (primary brake).** Every successful block increments `state.iteration` by 1. If `iteration >= max_iterations`, we terminate. `stop_hook_active` is not directly consulted for termination — the counter is the source of truth.

2. **Explicit write-failure detection.** If `write_state` cannot persist the incremented iteration (e.g., read-only filesystem, jq error, disk full), it returns non-zero. The caller treats this as a fatal condition: log an error, `delete_state` to break the loop, exit 0 without emitting a block decision. Since state can't be persisted, any further iterations would read the old counter and re-loop forever, so deletion is the safest recovery.

The earlier plan tried to add a "stuck-counter safety net" comparing `state.iteration` to `state.last_block_at_iteration`. That approach was broken:
- The pseudo-code set both fields to the same value on every block, making the equality check fire on the second Stop in a chain and terminating the loop after one iteration.
- Even with the prose semantics (`last_block_at_iteration = old_iter`, `iteration = new_iter`), the check still couldn't catch write failures: a failed write leaves the on-disk state unchanged, so the next Stop reads old values that are internally consistent (`iter = N, last = N-1`), and the stuck check doesn't fire.
- The real fix for write failures is `write_state` returning non-zero. The `last_block_at_iteration` field has been removed from the state schema.

## Session guards

Because state files are keyed by session_id (`state-<session_id>.json`), session guards are entirely structural:

- **Stop hook**: reads stdin session_id, loads `state-<session_id>.json`. Foreign sessions are invisible (their state lives in a different file).
- **UserPromptSubmit hook**: same — loads state by stdin session_id.
- **Control subcommands**: derive session_id via `resolve_session_id` (pending file lookup, then cwd-based fallback).

**No cwd-based rejection.** Earlier versions of the plan cross-checked `state.cwd` against the event's `cwd` and exited without acting on mismatch. That was removed because:

1. Pi has no cwd context at all — its loops are purely per-session. Adding a cwd check was a Claude-Code-specific invention without a clear motivation.
2. It created a weird "limbo" state when the user `cd`'d mid-session: the loop remained active but wouldn't re-inject, leaving state.paused unchanged. Users had no visibility into why the loop suddenly stopped advancing.
3. The rationale "covers the rare case of a user `cd`-ing mid-session" doesn't hold up — the review prompt is meta ("review the new code you just wrote with fresh eyes"); the model's sense of "new code" comes from conversation history, not cwd. Re-injecting after a `cd` is harmless.
4. With per-session state files, cross-session or cross-project leakage cannot happen even without a cwd check — each session has its own file.

**What the `cwd` field in state IS used for:** display in `/review-status` output (so the user can see where the loop was originally activated), and as a diagnostic field in hook logs. `activate_core` updates `state.cwd` on re-activation so `/review-start` after a `cd` retargets the display but doesn't reset anything else.

### Fallback when no pending file is found

If `resolve_session_id`'s primary path finds nothing (e.g., the user invokes `hook.sh activate` directly from a script, bypassing the skill, or the pending file was swept), it falls back to scanning `~/.claude/projects/`.

**Important caveat:** Claude Code's project-dir encoding is not a simple `/` → `-` transform. Empirical inspection shows dots, underscores, and possibly other characters are also rewritten:

- `/Users/kyroyo/.claude` → `-Users-kyroyo--claude` (double dash suggests `.` also → `-`)
- `/private/var/folders/dk/qssfz_y127l475pyh6f7y0yw0000gp/T/tmp.jCK4TvhD4U` → `-private-var-folders-dk-qssfz-y127l475pyh6f7y0yw0000gp-T-tmp-jCK4TvhD4U` (underscores and dots both → `-`)

The exact encoding function is undocumented and fragile to reimplement. Instead, the fallback uses an approach that doesn't depend on the encoding being invertible:

1. Iterate all `~/.claude/projects/*/` directories.
2. For each, list `.jsonl` transcript files sorted by mtime descending (`ls -t`, not `find -printf %T@` which is Linux-only).
3. Open the most recent transcript. Extract the `cwd` field from any event that has one. The pre-implementation verification (item 6) must confirm the exact location of the cwd field in the transcript schema.
4. If the extracted cwd matches `$PWD`, use this transcript's filename stem as the session_id.
5. Across all project dirs, pick the most recently modified transcript matching `$PWD`.

If no match is found, `resolve_session_id` prints the following to **stderr** (not a global variable, to survive the subshell call) and returns non-zero:

```
Cannot determine current Claude Code session.
Run this from inside a `claude` session so UserPromptSubmit can capture the session_id,
or create ~/.claude/review-loop/pending-<session>.json manually.
```

This fallback is **best-effort and unreliable** — the primary path is via the pending file written by `UserPromptSubmit`. Documented as such in the README.

**Pre-implementation verification items 6 and additional:** confirm transcript events or metadata contain `cwd`. If not, the fallback degrades to "attempts a best-guess `/` → `-` encoding and hopes for the best" with a loud warning. The diagnostic hook from the verification checklist should dump a transcript file for inspection.

## Known unknown: does UserPromptSubmit fire on Stop-injected continuations?

When the Stop hook blocks with `{"decision":"block","reason":"..."}`, Claude Code treats the reason as a new user turn. It is unclear from documentation whether this synthetic user turn fires `UserPromptSubmit`.

**Two cases the plan must handle:**

### Case A: UserPromptSubmit does NOT fire on forced continuations

Simplest case. Interrupt detection works naturally — only real user prompts fire the hook. No extra logic needed.

### Case B: UserPromptSubmit DOES fire on forced continuations

The hook would see the review prompt as a "user prompt", apply interrupt behavior, pause the loop, and break the continuation.

**Mitigation (two-layer):**

1. **Content check (primary):** The Stop hook stores the exact `reason` string it emitted into `state.last_block_reason`. The UserPromptSubmit hook compares `input_prompt` against it. The comparison strategy is determined by pre-implementation verification:
   - **Exact equality** if Claude Code passes `reason` verbatim.
   - **Starts-with / contains** if Claude Code wraps the reason in a prefix or suffix.
   - **First-100-char-prefix match** as a conservative default if we're unsure.

   The starting implementation uses **exact equality**, and the pre-implementation diagnostic hook is used to confirm or refine. Since the review prompt begins with a long distinctive phrase ("Great, now I want you to carefully read over all of the new code...") that is extremely unlikely to appear in genuine user input, a first-100-char match is a safe fallback if exact fails.

2. **Time check (backup, for cases where Claude Code mangles the reason beyond recognition):** The Stop hook also writes `state.last_block_at = <unix_ts>`. If the content check fails but `now - state.last_block_at < 2 seconds`, still treat as forced continuation. The 2-second window is tight enough to avoid most false positives (users rarely submit prompts within 2s of Claude finishing a response) while still catching the case where the forced continuation is dispatched nearly instantly.

3. **Fallback:** If neither check fires, treat as real user input.

**Why both:** the content check alone fails if Claude Code's transformation of `reason` is not known in advance. The time check alone fails if a real user prompt arrives within the window (rare but possible). Together they're robust.

**`last_block_reason` storage cost:** the review prompt is ~500–800 bytes. Storing it in the state file adds ~1KB per active loop. Negligible.

Before implementation, add a 10-line diagnostic hook that logs every UserPromptSubmit invocation with a timestamp AND the full prompt text, run a test review loop, and verify:
- Case A vs Case B (does UserPromptSubmit fire at all?)
- If Case B: what does `input_prompt` look like? Identical to the reason string, wrapped, truncated?

The diagnostic output determines which mitigation layer actually does the work. Ship both layers regardless — defense-in-depth.

## Concurrency

Stop hooks fire sequentially within a single Claude Code session (each turn ends with exactly one Stop event, and the next turn cannot start until the hook returns). With per-session state files, two concurrent sessions write to different files and never collide.

The only remaining race is: UserPromptSubmit and a control subcommand writing to the same pending file within microseconds. That would require a user to submit a prompt while a control subcommand is still running — near-impossible in practice since Claude Code serializes prompt handling.

Decision: no locking. Document the assumption; if it proves wrong in practice, revisit with `mkdir`-based mutex (macOS lacks `flock` by default).

### Known limitation: two concurrent sessions in the same project

If a user runs two `claude` instances in the same project directory simultaneously and both activate loops, the **control subcommands** (not the hooks) may operate on the wrong session's state. This is because `resolve_session_id` filters pending files by cwd and picks the most recent — if both instances write pending files within the same cwd, the fallback "pick most recent" heuristic is ambiguous.

The **hooks themselves** (Stop, UserPromptSubmit) are unaffected because they receive `session_id` directly in stdin JSON. Only the subcommand-driven control path is affected.

Mitigations considered and rejected:
- **Env var from Claude Code.** Would need Claude Code to set `CLAUDE_SESSION_ID` (or similar) when invoking the Bash tool. Status unknown — added to the pre-implementation verification checklist. If supported, `resolve_session_id` would use it directly with no heuristic.
- **PID/PPID matching.** Claude Code may set `CLAUDE_SESSION_ID` (TBD) but almost certainly not a stable PID. Skip.
- **File lock.** Over-engineering for a rare case.

Documented as a known limitation in the README. Users with this use case should run one loop at a time, or use two different project directories, or wait for the env var verification to determine if a cleaner fix is possible.

## Atomic writes

All writes to state, pending, config, AND `settings.json` go through a temp-file-and-rename pattern with a unique tempfile name to avoid collisions between concurrent writers:

```bash
tmp="${target}.tmp.$$"
jq '...' "$target" > "$tmp" && mv "$tmp" "$target"
```

`mv` within the same filesystem is atomic on POSIX. A crash mid-write leaves either the old file intact or the new file fully written — never a partial. `$$` ensures two concurrent writers don't clobber each other's tempfile.

This applies to setup.sh's `settings.json` merge as well — use `settings.json.tmp.$$` not the previously-documented `settings.json.tmp` which would race if two setup invocations ran simultaneously (unlikely but trivially avoided).

## Stale state cleanup

Two TTLs:

- **State files** (`state-<session_id>.json`): if `last_updated` is more than 2 hours old, `read_state` deletes the file and returns empty. Log a warning. Prevents a forgotten loop from haunting a future session.
- **Pending files** (`pending-<session_id>.json`): if `created_at` is more than 5 minutes old, `read_pending` deletes the file and returns empty.

Opportunistic global sweep: at the START of every hook invocation (before reading stdin), the script runs `find ~/.claude/review-loop -name 'state-*.json' -mmin +120 -delete` and `find ~/.claude/review-loop -name 'pending-*.json' -mmin +5 -delete`. This cleans up orphan files from sessions that ended abruptly. Silent on failure (sweep is best-effort). Running at the START is important because `handle_stop` and `handle_user_prompt` both `exit 0` on every path, so sweep-at-end would never execute.

## Settings.json merge

The setup.sh uses `jq` (already a dependency) to merge hooks into `~/.claude/settings.json`. The merge must:

1. **Create if missing.** On a fresh Claude Code install, `~/.claude/settings.json` may not exist yet (it's created lazily on first config change). If the file is absent, write `{}` to it first before attempting the merge. This matches the pattern already used in setup.sh for the pi extensions merge.
2. **Backup once.** If `settings.json.bak` does not exist, copy current settings.json to it after step 1 (so the backup reflects the pre-merge state, not the empty `{}` placeholder). Actually, for a fresh install the backup would be of an empty file — which is correct as a "pre-merge state" marker even if trivially empty.
3. **Verify the existing file is valid JSON.** Before running jq, run `jq -e . ~/.claude/settings.json >/dev/null`. If it fails (corrupt JSON), abort the merge with a loud error message referring the user to the backup file. Do NOT blindly overwrite a corrupt settings file.
4. Ensure `.hooks.Stop` is an array. If it doesn't contain any entry with `.hooks[]?.command == "~/.claude/hooks/review-loop.sh"`, append:
   ```json
   {"hooks": [{"type": "command", "command": "~/.claude/hooks/review-loop.sh"}]}
   ```
5. Do the same for `.hooks.UserPromptSubmit`.
6. Atomic write: temp file + rename.

**Use the literal `~` form, NOT `$HOME`-expanded.** The existing `claudeception-activator` hook in the user's settings uses literal `~/.claude/hooks/claudeception-activator.sh`, so our entry must match the same convention for two reasons:
1. **Portability across users** — literal `~` works for any user, while a `$HOME`-expanded path is specific to whoever ran setup.sh (breaks if the settings file is shared or copied).
2. **Idempotency of the jq match** — the `any(.hooks[]?.command == $cmd)` check is a string-equality test. If a previous run added the literal-`~` form and a subsequent run uses `$HOME`-expanded form (or vice versa), the match fails and the merge adds a duplicate entry. Consistency is enforced by always using the literal tilde.

Concrete jq expression (called once per event name, with unique tempfile to avoid concurrent-writer collisions):

```bash
HOOK_PATH="~/.claude/hooks/review-loop.sh"  # literal tilde, never $HOME-expanded
for EVENT in Stop UserPromptSubmit; do
    jq --arg cmd "$HOOK_PATH" --arg event "$EVENT" '
      .hooks[$event] = (
        (.hooks[$event] // []) as $existing
        | if ($existing | any(.hooks[]?.command == $cmd)) then
            $existing
          else
            $existing + [{"hooks": [{"type": "command", "command": $cmd}]}]
          end
      )
    ' ~/.claude/settings.json > "$HOME/.claude/settings.json.tmp.$$" && \
      mv "$HOME/.claude/settings.json.tmp.$$" ~/.claude/settings.json
done
```

This preserves all existing hooks (including `claudeception-activator`) and is idempotent on re-runs.

## Dependencies

- `jq` — already required for extensions merge. Hard dependency.
- **Bash 3.2+** — macOS default. **No bash 4+ features allowed**, in particular:
  - no `declare -A` (associative arrays)
  - no `local -n` / `declare -n` (namerefs)
  - no `readarray` / `mapfile`
  - no `${var^^}` / `${var,,}` case conversion
  - no `${var@Q}` transformation operators
  This forces helpers that "take a pattern-list name by reference" to use explicit per-kind functions (`get_exit_patterns`, etc.) instead of namerefs.
- `awk` — POSIX, everywhere.
- `sed` — POSIX.
- `find` — POSIX (but stale-sweep uses `-mmin` which is BSD/GNU but not strict POSIX; both macOS and Linux have it).
- `tail -r` (macOS) or `tac` (Linux) — detected at runtime, with an awk-based fallback if neither exists.
- `grep` with **PCRE support** (`-P`) is preferred for the lookbehind patterns `(?<!no\s)`. On macOS, BSD grep lacks `-P`. The script detects this:
  1. If `ggrep -P '' </dev/null 2>/dev/null`: use `ggrep -P` (GNU grep from homebrew).
  2. Else if `grep -P '' </dev/null 2>/dev/null`: use `grep -P`.
  3. Else: fall back to a two-pass check — pre-process the text with `sed 's/no issues/__EXCLUDED__/gi; s/no problems/__EXCLUDED__/gi; s/no bugs/__EXCLUDED__/gi'`, then run the bare pattern against the sanitized text. This is an ad-hoc approximation but handles the only two lookbehind patterns pi uses (both guard against "no issues/problems found" in the issues-fixed counter list).
- **`\w` portability.** Several pi patterns use `\w` (word character class). GNU grep supports `\w` in both ERE and PCRE modes. BSD grep on macOS supports `\w` as a Perl extension in ERE mode as well — but to be safe, the script detects at startup: `echo ab | grep -Eq '\w' && USE_WORD_CLASS=1 || USE_WORD_CLASS=0`. If `\w` is unsupported, patterns are rewritten to `[[:alnum:]_]` (POSIX character class) at compile time.
- **Regex validation**: custom patterns from `config.json` are validated before use via `printf '' | grep -E "$pattern" >/dev/null 2>&1`. Invalid patterns are logged and skipped, never used unvalidated.

No new package dependencies beyond what setup.sh already requires.

## `setup.sh` changes

New section runs in the same "Claude Code / Amp" gate as skill linking:

1. Create `~/.claude/hooks/` if missing.
2. `link()` `global/claude-review-loop/hook.sh` → `~/.claude/hooks/review-loop.sh`.
3. Ensure the source file is executable: `chmod +x "$SCRIPT_DIR/global/claude-review-loop/hook.sh"`. This is idempotent and also handles the case where git lost the mode bit for any reason.
4. Create `~/.claude/review-loop/` if missing. Do **NOT** touch any `state-*.json`, `pending-*.json`, or existing `config.json` — only create the directory and symlink `prompts/` into it. (Step 7 below handles first-run config creation.)
5. `link()` `global/claude-review-loop/prompts` → `~/.claude/review-loop/prompts`.
6. Inside `global/claude-review-loop/prompts/`, create the two symlinks `code.md` and `plan.md` pointing to `../../extensions/pi-review-loop/prompts/double-check.md` and `double-check-plan.md` (done once in the repo; setup.sh verifies they exist and are valid symlinks).
7. If `~/.claude/review-loop/config.json` does not exist, write a default one with the schema above.
8. jq-merge the Stop and UserPromptSubmit hook entries into `~/.claude/settings.json` using the query above. Backup to `.bak` on first run.
9. Final summary prints: hook registration state (`jq '.hooks | keys' settings.json`), any live state files (`ls state-*.json 2>/dev/null | wc -l`), and the effective config (`cat config.json`).

**Post-install sanity check.** After all links and merges, setup.sh verifies the full installation is coherent:

1. `test -x "$CLAUDE_HOOKS_DIR/review-loop.sh"` — the hook symlink target is executable.
2. `test -r ~/.claude/review-loop/prompts/code.md && test -r ~/.claude/review-loop/prompts/plan.md` — the prompt symlinks resolve.
3. `jq -e '.hooks.Stop[]?.hooks[]? | select(.command | endswith("review-loop.sh"))' ~/.claude/settings.json >/dev/null` — the Stop hook entry exists in settings.
4. Same for `.hooks.UserPromptSubmit`.
5. `jq -e '.' ~/.claude/review-loop/config.json >/dev/null` — config is valid JSON.

If any check fails, print a loud warning with the specific failure. The loop will not work if any of these are broken, and silently breaking is worse than noisily warning.

## `hook.sh` structure

Pseudo-code:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Preflight: required tools and environment. If any check fails, the hook
# MUST exit 0 (not non-zero) so Claude Code doesn't treat a broken hook as
# a block-the-stop signal. We degrade silently rather than interfering with
# the user's session.
if [ -z "${HOME:-}" ]; then
    # No home directory — paths would resolve to /. Log to /tmp and bail.
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) review-loop: HOME unset, exiting" \
        >> /tmp/review-loop-preflight.log 2>/dev/null || true
    exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
    # jq is a hard dependency of every code path. Log and bail.
    mkdir -p "$HOME/.claude/review-loop" 2>/dev/null || true
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) review-loop: jq not found in PATH, exiting" \
        >> "$HOME/.claude/review-loop/hook.log" 2>/dev/null || true
    exit 0
fi

# Paths
STATE_DIR="${REVIEW_LOOP_STATE_DIR_OVERRIDE:-$HOME/.claude/review-loop}"
CONFIG_FILE="$STATE_DIR/config.json"
PROMPTS_DIR="$STATE_DIR/prompts"
LOG_FILE="$STATE_DIR/hook.log"
# Per-session files computed as: $STATE_DIR/state-<session_id>.json, etc.

# Helper layer (see Shared helper function layer above)
log() { ... }
resolve_session_id() { ... }
read_state() { local sid="$1"; ... }
write_state() { local sid="$1" json="$2"; ... }
delete_state() { local sid="$1"; ... }
set_paused() { local sid="$1" val="$2"; ... }
read_pending() { local sid="$1"; ... }
write_pending() { ... }
delete_pending() { ... }
read_config() { ... }
activate_core() { local sid="$1" cwd="$2" kind="$3" focus="$4"; ... }
build_prompt() { ... }
read_last_assistant_text() { ... }
matches_exit() { ... }
matches_issues_fixed() { ... }
matches_trigger() { ... }
compile_pattern_list() { ... }
stale_sweep() { ... }

# Dispatch
if [ $# -eq 0 ]; then
    # Hook mode: read stdin JSON, branch on hook_event_name.
    # stale_sweep runs FIRST so it happens on every invocation regardless of
    # whether the handlers exit early. Placing it after the case would make
    # it unreachable because handle_stop and handle_user_prompt both `exit 0`
    # on every code path.
    stale_sweep  # opportunistic cleanup (best-effort, silent on failure)
    input=$(cat)
    event=$(jq -r '.hook_event_name' <<<"$input")
    case "$event" in
        Stop)              handle_stop "$input" ;;
        UserPromptSubmit)  handle_user_prompt "$input" ;;
        *)                 exit 0 ;;
    esac
else
    # Subcommand mode. Resolution of session_id is per-subcommand because
    # selftest doesn't need a Claude Code session at all (runs in a tempdir),
    # and the config-mutation subcommands (max/auto/interrupt) operate on
    # the global config.json and don't need a per-session state either.
    # Resolving session_id unconditionally up here would break all of those
    # when run outside a live Claude Code session.
    case "$1" in
        selftest)
            cmd_selftest
            ;;
        max)
            cmd_max "${2:-}"
            ;;
        auto)
            cmd_auto "${2:-toggle}"
            ;;
        interrupt)
            cmd_interrupt "${2:-}"
            ;;
        activate|deactivate|pause|resume|status)
            # Subcommands that operate on a specific session's state.
            # resolve_session_id prints errors to stderr itself; caller
            # just needs to detect failure and exit.
            if ! SESSION_ID=$(resolve_session_id); then
                exit 2
            fi
            case "$1" in
                activate)    cmd_activate   "$SESSION_ID" "${2:-code}" "${REVIEW_LOOP_FOCUS:-}" ;;
                deactivate)  cmd_deactivate "$SESSION_ID" ;;
                pause)       cmd_pause      "$SESSION_ID" ;;
                resume)      cmd_resume     "$SESSION_ID" ;;
                status)      cmd_status     "$SESSION_ID" ;;
            esac
            ;;
        *)
            echo "Unknown subcommand: $1" >&2
            exit 2
            ;;
    esac
fi
```

The `REVIEW_LOOP_STATE_DIR_OVERRIDE` env var exists purely so `selftest` can run in a tempdir without touching the user's real state. Production use never sets it.

Expected size: 500–700 lines of bash (larger than originally estimated due to regex lists, per-session state, config merging, pattern matching, fallback logic, and safety checks). The script must be thoroughly commented because it's complex.

### Shared helper function layer

To avoid duplicated logic between subcommands and hook handlers, the script exposes a helper layer that both call:

**Return value conventions:**
- **Read helpers** (`read_state`, `read_pending`, `read_config`): print JSON or empty to stdout, return exit code 0 in normal operation. A missing, stale, or corrupt file produces empty stdout with exit 0. Non-zero exit is reserved for unrecoverable I/O errors (disk unreadable, etc.). Callers test `[ -z "$result" ]` to detect "no data".
- **Write helpers** (`write_state`, `write_pending`): return exit 0 on successful persist, non-zero on any failure (jq error, disk full, rename fail). Callers that depend on the write succeeding MUST check the return value and take recovery action (see `handle_stop` step 9).
- **Mutate helpers** (`delete_state`, `delete_pending`): best-effort, always return 0. Missing file is not an error.
- **Read-modify-write helper** (`set_paused`): reads state, mutates, writes back. Returns non-zero if the read fails (missing state) or the write fails (delegates to `write_state`). Callers MUST check the return value — unlike the delete helpers, a failed set_paused leaves the loop in an inconsistent state if not handled (see the recovery patterns in `handle_stop` step 5 and the interrupt handler).
- **Pure helpers** (`matches_*`, `build_prompt`, `read_last_assistant_text`, `compile_pattern_list`): return 0 on success, non-zero on failure (e.g., build_prompt can't read prompt file).

**List of helpers:**

- `resolve_session_id()` — for subcommands, finds current session via pending file or transcript cwd lookup. Prints the session_id to **stdout** on success, returns 0. On failure, prints a human-readable error message to **stderr** and returns non-zero. Do NOT use a global variable like `RESOLVE_ERROR` — the function is always called via command substitution (`$(resolve_session_id)`), which runs in a subshell where variables set inside the function don't propagate back to the caller.
- `read_state <session_id>` — reads `$STATE_DIR/state-<session_id>.json`, validates embedded session_id matches filename, applies 2h stale TTL (deletes + returns empty if stale), prints JSON or empty.
- `write_state <session_id> <json>` — atomic temp-and-rename write to `$STATE_DIR/state-<session_id>.json`. Returns **non-zero on any failure** (jq parse error, tmp write failure, rename failure). Caller is responsible for setting `last_updated` in the JSON; helper does not auto-update timestamps.
- `delete_state <session_id>` — `rm -f` state file. Never errors on missing file.
- `set_paused <session_id> <bool>` — partial update: reads state, sets `.paused = $bool`, sets `.last_updated = now`, writes back. Callers are responsible for ensuring state exists before calling (typically they have just loaded it). If state is missing, set_paused is a no-op and returns non-zero (the caller should treat that as an error). Returns non-zero if the write fails (delegates to `write_state`).
- `read_pending <session_id>` — reads `$STATE_DIR/pending-<session_id>.json`, applies 5-minute TTL (see note below), prints JSON or empty. Extracts session_id from the JSON `.session_id` field, not from the filename (more robust if filenames get renamed).
- `write_pending <session_id> <cwd> <delayed> <kind> [focus]` — atomic create of pending file with `created_at = now`. `focus` is optional (defaults to empty string) and is used only for `/review-start` and `/review-plan` slash commands where UserPromptSubmit parsed focus text from the user's prompt. Returns non-zero on failure.
- `delete_pending <session_id>` — `rm -f` pending file. Never errors on missing file.
- `read_config` — reads `$CONFIG_FILE`, merges on-disk values against hardcoded defaults baked into the script (so missing fields get defaults, unknown fields are passed through), tolerates malformed JSON by falling back entirely to defaults with a log warning. Prints JSON to stdout.
- `activate_core <session_id> <cwd> <kind> <focus>` — creates or updates state for a session. See dedicated section below for full pseudo-code. Returns exit 0 on success, non-zero on write error. Used by the `activate` subcommand AND the auto-trigger promotion in `handle_stop`.
- `build_prompt <kind> <focus>` — reads the prompt file (see dedicated section below for override logic), strips YAML frontmatter, strips `$@` placeholder, trims, appends focus text. Prints result to stdout. Returns non-zero if the prompt file is unreadable.
- `read_last_assistant_text <transcript_path>` — walks transcript backward up to 500 lines, returns the first non-empty concatenation of text blocks from an assistant event. Prints empty on missing or empty transcript.
- `matches_exit <text>` / `matches_issues_fixed <text>` / `matches_trigger <text>` — regex checks. Each calls `compile_pattern_list` internally on every invocation (the cost is negligible: just array construction and string validation). Returns 0 (match) or 1 (no match).
- `log <message>` — timestamped append to hook.log. See Log rotation below.
- `compile_pattern_list <kind>` — returns the final pattern list for the given kind (`exit`, `issues_fixed`, or `trigger`) by reading the hardcoded defaults, reading config for mode and custom patterns, validating each custom pattern, and applying the mode. Implementation uses per-kind helper functions (`get_exit_patterns`, `get_issues_fixed_patterns`, `get_trigger_patterns`) rather than bash namerefs, for bash 3.2 compatibility.
- `stale_sweep` — opportunistic `find -mmin` cleanup of orphan state and pending files, with explicit error suppression: `find ... 2>/dev/null || true`. Silent on failure (the sweep is best-effort; a failing sweep must never prevent the rest of the hook from running). Also handles the case where `$STATE_DIR` doesn't exist yet (find returns error, suppressed).

**Pending TTL was extended from 60s to 5 minutes.** Claude Code's skill loading is asynchronous — between the user submitting a prompt (which fires UserPromptSubmit and writes the pending file) and the skill body actually running the bash subcommand (which reads the pending file), Claude may spend several seconds analyzing, thinking, or executing prior tool calls. 60 seconds turned out to be too tight for complex skill bodies; 5 minutes is generously forgiving without creating orphan risk (the stale-sweep still catches abandoned ones). Updated the sweep command to `find ... -name 'pending-*.json' -mmin +5 -delete`.

### Log rotation details

The `log` helper appends timestamped lines to `$LOG_FILE`. Before each append, it checks file size:

```bash
log() {
    local msg="$*"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    # Rotate if > 1 MiB. Use a portable file-size check that works on both
    # macOS (BSD stat -f%z) and Linux (GNU stat -c%s). Fall back to wc -c.
    local size=0
    if [ -f "$LOG_FILE" ]; then
        size=$(stat -f%z "$LOG_FILE" 2>/dev/null \
             || stat -c%s "$LOG_FILE" 2>/dev/null \
             || wc -c < "$LOG_FILE" 2>/dev/null \
             || echo 0)
    fi
    if [ "$size" -gt 1048576 ]; then
        mv "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
    fi
    echo "$ts $msg" >> "$LOG_FILE" 2>/dev/null || true
}
```

Log writes are best-effort (silently ignore failures). Only one old log is kept (`.1`); older data is discarded.

### Subcommand semantics (must match pi where applicable)

| Subcommand | Inactive state | Active state (same kind) | Active state (different kind) | Paused state |
|---|---|---|---|---|
| `activate <kind> [focus]` | Create state (iteration=0), print prompt | Update focus if provided, print prompt (no iteration reset) | Switch kind, update focus, print new prompt (no iteration reset) | Clear paused, update focus, print prompt |
| `deactivate` | Print "not active" | Delete state, print "stopped" | Delete state, print "stopped" | Delete state, print "stopped" |
| `pause` | Print "not active" | Set paused=true, print status | Set paused=true, print status | Print "already paused" |
| `resume` | Print "not active" | Print "already running" | Print "already running" | Clear paused, print prompt |
| `status` | Print "inactive" with config summary | Print iteration, max, kind, focus, etc. | Same | Same + "paused" flag |
| `max <N>` | Update config.max_iterations | Update config (affects current loop next Stop) | Same | Same |
| `auto <on\|off\|toggle>` | Update config.auto_trigger | Update config | Same | Same |
| `interrupt <pause\|stop>` | Update config.interrupt_behavior | Update config (takes effect on next interrupt) | Same | Same |
| `selftest` | Run canned scenarios in a tempdir, exit 0/1 | Same | Same | Same |

Key behaviors to match pi exactly:

- **Activate never resets the iteration counter when already active.** Matches pi's `review-start` handler which updates focus/kind on an active loop without restarting.
- **Activate switches kind on the fly.** Running `/review-plan` during an active code loop should swap to the plan prompt starting next iteration.
- **Activate with mismatched cwd updates the stored cwd.** If the user `cd`'d since activation and re-runs `/review-start`, `activate_core` updates `state.cwd` to the new PWD. This is a display-only field used for `/review-status` and logging; the loop itself has no cwd-dependent behavior (no cwd check in `handle_stop` or `handle_user_prompt`). Never resets iteration.
- **Resume prints the current prompt to stdout** so Claude immediately does the next review pass — the skill body just says "follow the output of this command".
- **Max/auto/interrupt persist globally in `config.json`.** This is a behavioral delta from pi where they are session-scoped; documented in the README as the only intentional semantic difference (besides the dropped fresh-context, the `/review-auto` focus-text shortcut, and the auto-trigger semantic difference above).

## `handle_stop` logic in detail

```
input_session=$(jq -r '.session_id' <<<"$input")
input_cwd=$(jq -r '.cwd' <<<"$input")
input_transcript=$(jq -r '.transcript_path' <<<"$input")
stop_active=$(jq -r '.stop_hook_active // false' <<<"$input")

# 1. Auto-trigger promotion: if a delayed pending exists for this session,
#    promote it to active state BEFORE checking state. This handles the
#    auto-trigger flow (pending was created by UserPromptSubmit when it saw
#    a trigger pattern; now that Claude has finished the user's original
#    request, we activate the loop).
pending=$(read_pending "$input_session")  # reads pending-<session_id>.json, honoring TTL
if [ -n "$pending" ] && [ "$(jq -r '.delayed' <<<"$pending")" = true ]; then
    existing_state=$(read_state "$input_session")
    if [ -z "$existing_state" ] || [ "$(jq -r '.active' <<<"$existing_state")" != true ]; then
        # Validate kind before use — reject anything that isn't "code" or "plan"
        # to guard against a corrupted pending file. Default to "code".
        pending_kind=$(jq -r '.kind' <<<"$pending")
        case "$pending_kind" in
            code|plan) ;;
            *) log "WARN session $input_session: invalid kind '$pending_kind' in pending, defaulting to code"
               pending_kind=code ;;
        esac
        activate_core "$input_session" "$input_cwd" "$pending_kind" "" \
            || log "ERROR session $input_session: activate_core failed during auto-trigger promotion"
    fi
    # Always clean up the delayed pending — it's served its purpose regardless
    # of whether activation happened (state may already exist from a manual start).
    delete_pending "$input_session"
fi

# 2. Load state for THIS session. read_state returns empty (not a non-zero
#    exit) when the state file is missing or stale, so we must explicitly
#    test for emptiness rather than rely on || exit 0.
state=$(read_state "$input_session")
if [ -z "$state" ]; then
    exit 0  # no state → allow stop
fi

# 3. Standard guards
if [ "$(jq -r '.active' <<<"$state")" != true ]; then exit 0 ; fi
if [ "$(jq -r '.paused' <<<"$state")" = true ]; then
    log "session $input_session: paused, allowing stop"
    exit 0
fi
# No cwd check — matches pi's session-scoped semantics.
# session_id guard is implicit (we loaded state-<input_session>.json),
# but double-check the embedded session_id as a tamper check against
# someone hand-editing the state file.
if [ "$(jq -r '.session_id' <<<"$state")" != "$input_session" ]; then
    log "session $input_session: state file mismatch, allowing stop"
    exit 0
fi

# 4. Extract last assistant text
text=$(read_last_assistant_text "$input_transcript")

# 5. Abort/empty-text handling: if the model didn't actually respond
#    (aborted, thinking-only, or empty text), pause instead of re-inject.
#    Matches pi's behavior of pauseReview on empty/aborted assistant output.
if [ -z "$text" ]; then
    log "session $input_session: empty assistant text, pausing loop"
    if ! set_paused "$input_session" true; then
        # set_paused failed (disk full, state file missing mid-operation).
        # Fall back to deleting state — safer than leaving the loop active
        # but un-paused, which would cause infinite re-invocation.
        log "ERROR session $input_session: set_paused failed, deleting state"
        delete_state "$input_session"
    fi
    exit 0
fi

# 6. Termination: exit phrase AND NOT issues-fixed counter
if matches_exit "$text" && ! matches_issues_fixed "$text"; then
    delete_state "$input_session"
    log "session $input_session: deactivated (no issues found)"
    exit 0
fi

# 7. Increment iteration THEN check max (must match pi's agent_end which
#    increments currentIteration BEFORE comparing against maxIterations).
#    Without this order, the loop allows max_iterations+1 passes because the
#    initial pass (printed by cmd_activate or cmd_resume) doesn't itself
#    increment the counter — the first Stop fires with iter=0 regardless.
#    By incrementing first, the count of completed passes stays in sync:
#      - Explicit: cmd_activate prints pass 1, Stop increments 0→1,
#        1>=7? no, block → pass 2, ..., Stop increments 6→7, 7>=7, done.
#        Total: 7 passes.
#      - Auto-trigger: Stop promotes pending, increments 0→1, block → pass 1,
#        ..., 6→7, done. Total: 7 passes.
#      - Resume from iter=3: cmd_resume prints pass 4, Stop increments 3→4,
#        ..., 6→7, done. Total: 3+4=7 passes.
config=$(read_config)
max=$(jq -r '.max_iterations' <<<"$config")
iter=$(jq -r '.iteration' <<<"$state")
new_iter=$((iter + 1))

if [ "$new_iter" -ge "$max" ]; then
    delete_state "$input_session"
    log "session $input_session: deactivated (max iterations, pass $new_iter >= $max)"
    exit 0
fi

# 8. All clear — build prompt, persist state, emit block.
#    Build the prompt BEFORE updating state, so we can store the exact reason
#    into last_block_reason for Case B content-based forced-continuation detection.
kind=$(jq -r '.kind' <<<"$state")
focus=$(jq -r '.focus // ""' <<<"$state")
if ! prompt=$(build_prompt "$kind" "$focus"); then
    log "ERROR session $input_session: build_prompt failed, pausing loop"
    if ! set_paused "$input_session" true; then
        log "ERROR session $input_session: set_paused also failed, deleting state"
        delete_state "$input_session"
    fi
    exit 0
fi

now=$(date +%s)
new_state=$(jq \
    --argjson iter "$new_iter" \
    --argjson now "$now" \
    --arg reason "$prompt" \
    '.iteration = $iter
     | .last_updated = $now
     | .last_block_at = $now
     | .last_block_reason = $reason' \
    <<<"$state")

# 9. Persist state with explicit error handling. If the write fails (read-only
#    filesystem, disk full, jq error) we MUST NOT emit a block — doing so would
#    cause the next Stop to read the old unincremented state and loop forever.
#    Instead, log, delete state, and allow the stop normally.
if ! write_state "$input_session" "$new_state"; then
    log "ERROR session $input_session: state write failed at iter $new_iter, aborting loop"
    delete_state "$input_session"
    exit 0
fi

log "session $input_session: iter $new_iter/$max → block"
jq -n --arg reason "$prompt" '{decision: "block", reason: $reason}'
exit 0
```

### Abort / empty-text rationale

Pi's `agent_end` handler calls `pauseReview` when `lastAssistant.aborted || !lastAssistant.text.trim()`. We match that by pausing rather than re-injecting. This protects against:

- User pressed Esc mid-response (aborted turn)
- Claude's response was thinking-only (no text blocks)
- Claude emitted only tool calls with no wrap-up text

In all three cases, re-injecting the review prompt would be confusing or wasteful. Pausing makes the user run `/review-resume` to explicitly continue, matching pi's UX.

## `activate_core` pseudo-code

Shared activation logic used by both the `activate` subcommand and the auto-trigger promotion in `handle_stop`. Pseudo-code:

```bash
activate_core() {
    local sid="$1" cwd="$2" kind="$3" focus="$4"
    local now existing new_state
    now=$(date +%s)
    existing=$(read_state "$sid")

    if [ -z "$existing" ]; then
        # Fresh activation
        new_state=$(jq -n \
            --arg sid "$sid" \
            --arg cwd "$cwd" \
            --arg kind "$kind" \
            --arg focus "$focus" \
            --argjson now "$now" \
            '{
                active: true,
                paused: false,
                iteration: 0,
                kind: $kind,
                focus: $focus,
                session_id: $sid,
                cwd: $cwd,
                started_at: $now,
                last_updated: $now,
                last_block_at: 0,
                last_block_reason: ""
            }')
    else
        # Update existing: clear paused, update kind and cwd, update focus
        # ONLY if non-empty (empty focus from auto-trigger promotion must not
        # wipe an explicit focus set by a prior /review-start), preserve
        # iteration to match pi's "no reset on re-activation" semantics.
        new_state=$(jq \
            --arg kind "$kind" \
            --arg focus "$focus" \
            --arg cwd "$cwd" \
            --argjson now "$now" \
            '.active = true
             | .paused = false
             | .kind = $kind
             | .cwd = $cwd
             | (if $focus != "" then .focus = $focus else . end)
             | .last_updated = $now' \
            <<<"$existing")
    fi

    if ! write_state "$sid" "$new_state"; then
        log "ERROR session $sid: activate_core write failed"
        return 1
    fi
    return 0
}
```

Note on the cwd update: pi's loop is stored in session state, so it has no cwd to check. Our implementation updates `state.cwd` on re-activation to the current PWD, which means a user who `cd`'d between invocations gets the loop retargeted to the new directory. See the "Activate with mismatched cwd" note in the subcommand semantics table.

## `cmd_activate` and `cmd_resume` pseudo-code

These two subcommands are the only ones that print the review prompt to stdout, which is how Claude receives the instructions to review. The others just mutate state and print status.

```bash
cmd_activate() {
    local sid="$1" kind="$2" focus="${3:-}"
    local cwd="$PWD"

    # Validate kind up front so we don't create garbage state.
    case "$kind" in
        code|plan) ;;
        *) echo "ERROR: kind must be 'code' or 'plan', got: $kind" >&2
           exit 2 ;;
    esac

    # Focus resolution order: env var (REVIEW_LOOP_FOCUS, passed as $3) takes
    # precedence, then fall back to pending.focus (parsed by UserPromptSubmit
    # from the user's slash command text). This handles the case where the
    # model can't see text after the slash command name (verification item 11).
    if [ -z "$focus" ]; then
        local pending
        pending=$(read_pending "$sid")
        if [ -n "$pending" ]; then
            focus=$(jq -r '.focus // ""' <<<"$pending")
        fi
    fi

    if ! activate_core "$sid" "$cwd" "$kind" "$focus"; then
        echo "ERROR: activation failed. Check ~/.claude/review-loop/hook.log for details." >&2
        exit 1
    fi

    # Print the review prompt for Claude to follow. build_prompt already
    # reads the current state's focus via its own parameter, so we pass
    # the focus we just wrote.
    if ! build_prompt "$kind" "$focus"; then
        echo "ERROR: could not build review prompt. Check prompts directory." >&2
        exit 1
    fi
}

cmd_resume() {
    local sid="$1"
    local state
    state=$(read_state "$sid")

    if [ -z "$state" ]; then
        echo "Review loop is not active for this session."
        return 0
    fi

    if [ "$(jq -r '.paused' <<<"$state")" != true ]; then
        echo "Review loop is already running (not paused)."
        return 0
    fi

    # Clear paused, update last_updated
    if ! set_paused "$sid" false; then
        echo "ERROR: could not clear paused state." >&2
        exit 1
    fi

    # Print the review prompt for Claude to follow
    local kind focus
    kind=$(jq -r '.kind' <<<"$state")
    focus=$(jq -r '.focus // ""' <<<"$state")
    if ! build_prompt "$kind" "$focus"; then
        echo "ERROR: could not build review prompt." >&2
        exit 1
    fi
}
```

The other `cmd_*` wrappers are straightforward state-mutation + status-print pairs and don't need pseudo-code in the plan. See the subcommand semantics table for their behavior matrix.

## `build_prompt` pseudo-code and override logic

Builds the review prompt text for a given `kind` (code or plan), honoring user overrides from `config.json`.

```bash
build_prompt() {
    local kind="$1" focus="$2"
    local config override file content
    config=$(read_config)

    # Config override: .prompt_code or .prompt_plan. Null/empty → use default.
    override=$(jq -r ".prompt_$kind // empty" <<<"$config")

    if [ -n "$override" ]; then
        # Expand leading ~ if present
        case "$override" in
            '~/'*)  file="$HOME/${override#~/}" ;;
            *)      file="$override" ;;
        esac
    else
        file="$PROMPTS_DIR/$kind.md"
    fi

    if [ ! -r "$file" ]; then
        log "ERROR: prompt file not readable: $file"
        return 1
    fi

    # One awk pass: strip YAML frontmatter (only if --- is at line 1),
    # trim leading blank lines (skip until first non-blank), and trim
    # trailing blank lines (buffer and emit up to last non-blank).
    content=$(awk '
        NR == 1 && /^---$/ { skip = 1; next }
        skip && /^---$/    { skip = 0; next }
        skip              { next }
        /^[[:space:]]*$/ && !started { next }        # skip leading blanks
        { started = 1; buf[++n] = $0 }
        END {
            last = n
            while (last > 0 && buf[last] ~ /^[[:space:]]*$/) last--
            for (i = 1; i <= last; i++) print buf[i]
        }
    ' "$file" | sed 's/\$@//g')

    if [ -n "$focus" ]; then
        printf '%s\n\n**Additional focus:** %s\n' "$content" "$focus"
    else
        printf '%s\n' "$content"
    fi
    return 0
}
```

Note: the single awk pass handles frontmatter stripping, leading-blank trimming, and trailing-blank trimming in one pipeline. The `sed 's/\$@//g'` runs after awk to strip pi's `$@` placeholder from the already-trimmed content.

## `handle_user_prompt` logic in detail

```
input_session=$(jq -r '.session_id' <<<"$input")
input_cwd=$(jq -r '.cwd' <<<"$input")
input_prompt=$(jq -r '.prompt // empty' <<<"$input")

# 1. Load per-session state (may be empty if no loop active for this session).
#    read_state prints empty and returns 0 on missing, so no error handling needed.
state=$(read_state "$input_session")
config=$(read_config)

# 2. Control-command pre-capture FIRST — BEFORE Case B mitigation. /review-*
#    commands are always real user input (Claude Code never synthesizes them
#    as forced continuations), so they must never be treated as Case B
#    forced continuations. Reordering also covers the edge case where the
#    user types /review-start within 2 seconds of a block emission: without
#    this reordering, the Case B time-check would drop the /review-start.
#
#    For /review-start and /review-plan specifically, we ALSO parse the focus
#    text (everything after the command name) and store it in the pending
#    file. cmd_activate uses this as a fallback when the REVIEW_LOOP_FOCUS
#    env var is empty. This is the source of truth for focus, because the
#    model's ability to extract args from slash-command prompts is an
#    empirical unknown (see verification item 11).
if [[ "$input_prompt" =~ ^/review- ]]; then
    parsed_focus=""
    parsed_kind=""
    # Normalize newlines/CRs to spaces so the pattern match and sed extraction
    # work correctly even if the user's prompt spans multiple lines.
    normalized=$(printf '%s' "$input_prompt" | tr '\n\r' '  ')
    # The case patterns use double quotes + glob to require a word boundary
    # after the command name: either end-of-string or a space. This prevents
    # a prompt like "/review-start-foo" from being treated as /review-start.
    case "$normalized" in
        "/review-start"|"/review-start "*)
            parsed_kind="code"
            parsed_focus=$(printf '%s' "$normalized" | sed -E 's|^/review-start[[:space:]]*||; s|[[:space:]]+$||')
            ;;
        "/review-plan"|"/review-plan "*)
            parsed_kind="plan"
            parsed_focus=$(printf '%s' "$normalized" | sed -E 's|^/review-plan[[:space:]]*||; s|[[:space:]]+$||')
            ;;
        # Other /review-* commands (pause, resume, exit, status, max, auto,
        # interrupt): no kind or focus to extract. The pending file is still
        # written because control subcommands use it to resolve session_id.
    esac
    write_pending "$input_session" "$input_cwd" false "$parsed_kind" "$parsed_focus"
    exit 0
fi

# 3. Case B mitigation: detect forced continuations from the Stop hook and
#    skip interrupt handling in that case. Two layers:
#    (a) content check: if input_prompt equals state.last_block_reason,
#        this IS the reason we just emitted, so it's a forced continuation.
#    (b) time check: if we recently emitted a block (< 2s ago) but content
#        doesn't match (because Claude Code wrapped or mangled the reason),
#        still treat as forced continuation. The tight 2s window minimizes
#        false positives on fast real user input.
#    Reached only for non-/review-* prompts (step 2 exits on those).
if [ -n "$state" ]; then
    last_reason=$(jq -r '.last_block_reason // ""' <<<"$state")
    last_block=$(jq -r '.last_block_at // 0' <<<"$state")
    now=$(date +%s)

    if [ -n "$last_reason" ] && [ "$input_prompt" = "$last_reason" ]; then
        log "session $input_session: UserPromptSubmit matches last_block_reason, forced continuation"
        exit 0
    fi
    if [ "$((now - last_block))" -lt 2 ]; then
        log "session $input_session: UserPromptSubmit within 2s of last block, treating as forced continuation (content mismatch)"
        exit 0
    fi
fi

# 4. Auto-trigger: if enabled AND state is inactive AND prompt matches a
#    trigger pattern, schedule an auto-activation. Do NOT activate the loop
#    immediately — that would interrupt the user's actual request. Instead,
#    write a delayed pending marker that handle_stop will promote.
auto_trigger_enabled=$(jq -r '.auto_trigger // false' <<<"$config")
if [ "$auto_trigger_enabled" = true ] && [ -z "$state" ]; then
    if matches_trigger "$input_prompt"; then
        write_pending "$input_session" "$input_cwd" true "code"
        # Note the "INTERNAL NOTE, do not mention in reply" framing: this
        # tells Claude to honor the signal without leaking the notice text
        # into its user-visible response. Otherwise Claude may echo the
        # notice verbatim ("I see there's a review loop scheduled..."),
        # which is confusing for the user.
        echo "[INTERNAL NOTE, do not mention in reply: Review loop will auto-activate after this response. Complete the user's request first; a review pass will begin automatically.]"
        exit 0
    fi
fi

# 5. Interrupt handling: applies when state is active for THIS session
#    (session_id is implicit via state-<input_session>.json). No cwd check
#    — the loop is session-scoped, not cwd-scoped.
if [ -n "$state" ] && [ "$(jq -r '.active' <<<"$state")" = true ]; then
    # Skip interrupt if the prompt matches a trigger pattern AND auto_trigger
    # is enabled (matches pi's `input` handler behavior: an auto-trigger
    # prompt is an intentional continuation, not an interrupt).
    if [ "$auto_trigger_enabled" = true ] && matches_trigger "$input_prompt"; then
        log "session $input_session: trigger match while active, skipping interrupt"
        exit 0
    fi

    behavior=$(jq -r '.interrupt_behavior // "pause"' <<<"$config")
    case "$behavior" in
        pause)
            if ! set_paused "$input_session" true; then
                # Write failed — fall back to deleting state so the loop
                # doesn't continue re-injecting over the user's message.
                log "ERROR session $input_session: set_paused failed during interrupt, deleting state"
                delete_state "$input_session"
            else
                log "session $input_session: interrupt → paused"
            fi
            ;;
        stop)
            delete_state "$input_session"
            log "session $input_session: interrupt → stopped"
            ;;
    esac
fi

exit 0
```

## Repo layout (new files)

```
global/claude-review-loop/
  hook.sh                        # the dispatch script (executable)
  prompts/
    code.md                      # symlink → ../../extensions/pi-review-loop/prompts/double-check.md
    plan.md                      # symlink → ../../extensions/pi-review-loop/prompts/double-check-plan.md
  README.md                      # docs (see below)

skills/review-start/SKILL.md     # /review-start
skills/review-plan/SKILL.md      # /review-plan
skills/review-pause/SKILL.md     # /review-pause
skills/review-resume/SKILL.md    # /review-resume
skills/review-exit/SKILL.md      # /review-exit
skills/review-status/SKILL.md    # /review-status
skills/review-max/SKILL.md       # /review-max
skills/review-auto/SKILL.md      # /review-auto
skills/review-interrupt/SKILL.md # /review-interrupt
```

The existing setup.sh skill-linking loop picks up the new skills automatically.

## Skill body template

Each skill's SKILL.md is a short instructions file telling Claude which bash subcommand to run and how to handle its output. The activation skills (`/review-start`, `/review-plan`) additionally instruct Claude to follow the printed prompt; the control skills (`/review-pause`, `/review-exit`, etc.) just relay the status to the user.

**Key design principle:** the skill body does NOT try to parse focus text or any other args from the user's prompt. That job belongs to the `UserPromptSubmit` hook, which has direct access to the prompt text via stdin JSON and writes parsed values into the pending file. The skill body's only responsibility is to invoke the bash subcommand and relay the output. This isolates the fragile model-based arg extraction to one place (the hook) that actually has the text.

Example for `/review-start`:

```markdown
---
name: review-start
description: Activate the iterative code review loop. Claude will re-review its own work until no issues remain or the iteration cap is hit.
---

You are activating the review loop. Do this now:

1. Run this bash command:

   ```bash
   bash ~/.claude/hooks/review-loop.sh activate code
   ```

   You do NOT need to extract focus text from the user's prompt — the
   UserPromptSubmit hook has already parsed it and stored it in a pending
   file that `activate` will read automatically.

2. The command prints the review instructions on stdout. Read them carefully
   and perform the review as instructed. Do not summarize the prompt — follow
   its response format exactly, including ending with either "Fixed N issue(s).
   Ready for another review." or "No issues found." as appropriate.

3. If the command fails (non-zero exit), relay its stderr message to the user
   instead of starting the review.
```

**Advanced override:** if Claude has clear visibility into focus text from the user's prompt AND wants to ensure the exact text is used (e.g., to work around an edge case in the UserPromptSubmit parser), it may prefix the command with `REVIEW_LOOP_FOCUS='...'`. This takes precedence over the pending file's focus field. Not needed in normal operation.

The other skill bodies follow the same structure but call different subcommands:
- `/review-plan`: `bash ~/.claude/hooks/review-loop.sh activate plan`, then follow the printed plan-review prompt. Same pending-file focus pattern.
- `/review-pause`: `bash ~/.claude/hooks/review-loop.sh pause`, then relay the output to the user.
- `/review-resume`: `bash ~/.claude/hooks/review-loop.sh resume`; if it prints a prompt, follow it; if it prints "not active" or "already running", relay that to the user.
- `/review-exit`: `bash ~/.claude/hooks/review-loop.sh deactivate`, then relay the output.
- `/review-status`: `bash ~/.claude/hooks/review-loop.sh status`, pretty-print for the user.
- `/review-max`: extract a positive integer N from the user prompt (the skill body should only invoke the subcommand if the input looks like a valid integer, otherwise print a usage message inline), then run `bash ~/.claude/hooks/review-loop.sh max N`. `cmd_max` validates again on its side.
- `/review-auto`: extract `on`, `off`, or `toggle` from the user prompt (default toggle if missing). If the user passes anything else (e.g., pi's dropped focus-text shortcut `/review-auto focus on X`), print a brief help message explaining the supported values and suggest `/review-start` for focus text, then stop without running the subcommand. Otherwise run `bash ~/.claude/hooks/review-loop.sh auto <arg>`. `cmd_auto` validates again on its side.
- `/review-interrupt`: extract `pause` or `stop`. If missing or invalid, print help inline and do not invoke the subcommand. Otherwise run `bash ~/.claude/hooks/review-loop.sh interrupt <arg>`. `cmd_interrupt` validates again.

**Defense in depth for all `cmd_*` validation:** the skill body performs a first-pass check (which is fragile because it relies on the model to parse args correctly), and the subcommand performs a second-pass check as the source of truth. If either rejects the input, no state mutation happens.

## Claude Code permission model

The two hook paths have fundamentally different trust models:

### Native hooks bypass the Bash tool permission system

Stop and UserPromptSubmit hooks registered in `~/.claude/settings.json` under `.hooks.*` are invoked **directly by Claude Code's hook runner**, not through the Bash tool. They do NOT go through `.permissions.allow` / `.permissions.deny` checks. This is verified by the existing `claudeception-activator` hook which runs as a `UserPromptSubmit` hook without any corresponding permission rule.

**Implication:** `handle_stop` and `handle_user_prompt` run with no permission friction. The loop's iterative block-and-re-inject cycle is transparent to the user.

### Skill body subcommand calls DO go through the Bash tool permission system

When a `/review-*` skill body instructs Claude to run `bash ~/.claude/hooks/review-loop.sh activate code`, Claude executes that via the Bash tool. Claude Code checks `.permissions.allow` for a matching rule; if none, it prompts the user. Looking at the current user's settings, there is no `Bash(bash:*)` or `Bash(~/.claude/hooks/*)` rule — only specific per-tool rules like `Bash(git status:*)`, `Bash(cat:*)`, etc.

**Implication:** on first use of any `/review-*` slash command, the user will see a permission prompt asking to approve the bash invocation. They can approve once or "always allow".

### Recommended permission rule

The README should recommend adding the following entry to `~/.claude/settings.json` under `.permissions.allow`:

```json
"Bash(bash ~/.claude/hooks/review-loop.sh:*)"
```

This allows any `bash ~/.claude/hooks/review-loop.sh <anything>` invocation without prompting. Setup.sh does NOT add this automatically — modifying permission rules is a security boundary we should not cross without explicit user consent. The README should include a one-line `jq` command the user can run to add it:

```bash
jq '.permissions.allow += ["Bash(bash ~/.claude/hooks/review-loop.sh:*)"] | .permissions.allow |= unique' \
  ~/.claude/settings.json > ~/.claude/settings.json.tmp.$$ && \
  mv ~/.claude/settings.json.tmp.$$ ~/.claude/settings.json
```

**Alternative invocation form considered:** calling `~/.claude/hooks/review-loop.sh activate code` directly (no `bash` prefix) since hook.sh is executable. This would require the permission rule `Bash(~/.claude/hooks/review-loop.sh:*)` instead. Both forms work; the plan uses `bash hook.sh` for explicitness and to avoid relying on the +x bit persisting across installs. The README documents both options.

### Pre-implementation verification

Add an item to the pre-implementation checklist: **does Claude Code set any env vars (e.g., `CLAUDE_SESSION_ID`, `CLAUDE_TRANSCRIPT_PATH`) when invoking the Bash tool?** If yes, `resolve_session_id` can read the session ID directly from the environment, eliminating both the pending-file heuristic AND the concurrent-sessions-in-same-project limitation. Test with a diagnostic skill body that runs `env | grep -i claude`.

## README.md contents

`global/claude-review-loop/README.md` must cover:

1. **What this is** — one paragraph summary, cross-linked to pi-review-loop.
2. **Architecture diagram** — ASCII or mermaid showing Stop + UserPromptSubmit + state files.
3. **Installation** — `./setup.sh` does it all.
4. **Commands** — table of all `/review-*` skills.
5. **Configuration** — `config.json` schema with every field explained.
6. **State and pending files** — schemas.
7. **How termination works** — exitPatterns vs issuesFixedPatterns with examples.
8. **Out of scope** — fresh-context mode, agent tool, and why.
9. **Debugging**:
   - `tail -f ~/.claude/review-loop/hook.log`
   - `ls ~/.claude/review-loop/state-*.json` to see active per-session state
   - `jq . ~/.claude/review-loop/state-<session_id>.json` to inspect a specific session
   - `bash ~/.claude/hooks/review-loop.sh selftest` to exercise the decision logic without Claude (uses a tempdir, won't touch real state)
   - `jq '.hooks' ~/.claude/settings.json` to verify hook registration
10. **Limitations** — known unknown about UserPromptSubmit + Case B mitigation, and how to tell if you've hit it.

## Testing (Step after implementation)

1. `bash -n hook.sh` → syntax OK.
2. `shellcheck hook.sh` → no errors (warnings reviewed).
3. `./setup.sh` → symlinks created, settings.json merged idempotently. Run twice, `diff settings.json.bak settings.json` should show exactly the new hook additions.
4. `hook.sh selftest` → runs in a throwaway tempdir (exported as `REVIEW_LOOP_STATE_DIR_OVERRIDE=/tmp/rl-selftest-$$`). Setup inside selftest:
   - `mkdir -p $REVIEW_LOOP_STATE_DIR_OVERRIDE/prompts`
   - Symlink `$REVIEW_LOOP_STATE_DIR_OVERRIDE/prompts/code.md` → the real `global/claude-review-loop/prompts/code.md` (repo path, discoverable via `$BASH_SOURCE` + `dirname` resolution). Same for `plan.md`. This gives the canned tests a real prompt to read without depending on `~/.claude/review-loop/` being set up.
   - Write a default `config.json` into the tempdir.
   - Write canned transcript JSONL fixtures into the tempdir (one with exit phrase + no issues fixed, one with exit phrase + issues fixed, one with only thinking content, etc.).
   - `trap 'rm -rf "$REVIEW_LOOP_STATE_DIR_OVERRIDE"' EXIT` for cleanup.

   **Subshell isolation:** because `handle_stop` and `handle_user_prompt` both call `exit 0` on every code path, selftest cannot invoke them directly in the same shell without terminating the whole selftest run. Since `cmd_selftest` runs as part of the same script that defines the handler functions, it can call them directly — but each call must be wrapped in a subshell so the handler's `exit 0` only terminates the subshell:
   ```bash
   # Inside cmd_selftest, for each test case:
   local input='{"hook_event_name":"Stop","session_id":"test-sid",...}'
   (handle_stop "$input") || true
   # Now inspect disk state to verify the handler did the right thing:
   test -f "$STATE_DIR/state-test-sid.json" || { echo "FAIL: state missing"; return 1; }
   ```
   State mutations persist on disk (in the tempdir) across subshells, so assertions after the subshell exit can inspect `state-*.json` files to verify behavior. There's no need to re-invoke the script via `bash "$0"` — the functions are already in scope.

   Exercises the following scenarios:
   - Stop hook with no state file → exit 0, no stdout
   - Stop hook with active state + exit phrase + no issues-fixed counter → exit 0, no stdout, state deleted
   - Stop hook with active state + exit phrase + issues-fixed counter → exit 0, block JSON printed (loop continues despite exit phrase because the model fixed things this pass)
   - Stop hook with active state + normal text, new_iter (= iteration + 1) < max → exit 0, block JSON emitted, state.iteration = new_iter
   - Stop hook with active state, iteration == max → exit 0, no stdout, state deleted
   - Stop hook where `write_state` fails (simulate via chmod 0 on the state file) → exit 0, state deleted, error logged (verifies write-failure recovery path)
   - Stop hook with empty assistant text (thinking only) → exit 0, state.paused=true
   - Stop hook with cwd-different-from-state.cwd → still blocks (loop is session-scoped, cwd is display-only; verifies no cwd-rejection regression)
   - Stop hook with pending (delayed=true) and no state → promotes pending, emits block JSON
   - Stop hook with pending (delayed=true) and invalid kind in pending (e.g., "xyz") → defaults to "code", logs warning, still promotes
   - UserPromptSubmit with `/review-start focus on error handling` → pending file created with kind=code, focus="focus on error handling" (verifies prompt parsing)
   - UserPromptSubmit with `/review-start` (no focus) → pending file created with kind=code, focus=""
   - UserPromptSubmit with `/review-start-xyz` → pending file created with kind="", focus="" (verifies word-boundary in case pattern; this isn't `/review-start`)
   - UserPromptSubmit with `/review-plan\nmore text` (newline in prompt) → pending file created with kind=plan, focus="more text" (verifies newline normalization)
   - `cmd_activate` with empty REVIEW_LOOP_FOCUS but pending.focus="X" → activates with focus="X" (verifies fallback resolution)
   - `cmd_activate` with REVIEW_LOOP_FOCUS="Y" and pending.focus="X" → activates with focus="Y" (verifies env var takes precedence)
   - Running `hook.sh selftest` outside a Claude Code session (no pending file, no ~/.claude/projects entry) → still succeeds (doesn't call resolve_session_id, verifies dispatch fix)
   - Running `hook.sh max 10` outside a Claude Code session → updates config.json (verifies config subcommands don't require session_id)
   - UserPromptSubmit with `/review-start` → pending file created with delayed=false
   - UserPromptSubmit with normal prompt, auto_trigger=true, state inactive, trigger match → delayed pending created, notice printed to stdout
   - UserPromptSubmit with normal prompt, state active, pause mode → state.paused=true
   - UserPromptSubmit with normal prompt, state active, stop mode → state deleted
   - UserPromptSubmit with content matching last_block_reason → no-op (Case B content mitigation)
   - UserPromptSubmit within 2s of state.last_block_at but content mismatch → no-op (Case B time mitigation)
   - UserPromptSubmit with trigger pattern, state active, auto_trigger=true → no interrupt (trigger skip)
   - UserPromptSubmit with trigger pattern, state active, auto_trigger=false → interrupt applied normally
   - `activate code` when state already active as plan → switches kind to code, preserves iteration
   - `activate code focus_text` when already active → updates focus, preserves iteration
   - `activate code` when paused → clears paused, iteration preserved, prompt printed
   - `resume` when state inactive → prints "not active", exit code 0
   - `resume` when paused → clears paused, prints current prompt
   - Stop hook with iteration == (max - 1), exit phrase matches, no issues-fixed → terminates via exit phrase (verifies exit check at step 6 runs before increment at step 7)
   - Stop hook with iteration == (max - 1), no exit phrase → new_iter = max, deactivates immediately (verifies increment-before-check matches pi; the review pass that just completed was the last one)
   - UserPromptSubmit with input_prompt exactly equal to state.last_block_reason → forced-continuation skip (content check)
   - UserPromptSubmit with content mismatch but time < 2s → forced-continuation skip (time check fallback)
   - UserPromptSubmit with content mismatch and time > 2s → real user input, interrupt applied
   - `selftest` cleans up tempdir on exit (trap EXIT).

5. Live test in Claude Code (after the selftest passes):
   - `claude` in a scratch dir
   - `/review-start` → verify state file created and loop runs
   - Capture hook.log, grep for the expected events
   - `/review-exit` mid-loop → verify deactivation
   - `/review-pause` → `/review-resume`, verify state survives across turns
   - Interrupt by normal prompt during active loop, verify pause behavior (default)
   - Set `/review-interrupt stop`, re-test interrupt → verify deactivation
   - `/review-auto on`, type trigger phrase, verify delayed activation
   - `/review-max 3`, run review, verify loop stops at 3 iterations
   - Two concurrent `claude` sessions in different dirs, both run `/review-start`, verify independent loops (check both `state-*.json` files)

6. Pre-implementation diagnostic hook (see Pre-implementation verification checklist below) must be run FIRST to answer the Case A vs B question and the other unknowns before writing any production code.

## Deliverables (one commit)

1. `global/claude-review-loop/hook.sh` (executable, 500–700 lines, heavily commented)
2. `global/claude-review-loop/prompts/code.md` (symlink to `../../extensions/pi-review-loop/prompts/double-check.md`)
3. `global/claude-review-loop/prompts/plan.md` (symlink to `../../extensions/pi-review-loop/prompts/double-check-plan.md`)
4. `global/claude-review-loop/README.md` (docs per the README.md contents section above)
5. `skills/review-start/SKILL.md` through `skills/review-interrupt/SKILL.md` (9 skills matching the command surface table)
6. `setup.sh` — new symlink section + jq merge for `.hooks.Stop` and `.hooks.UserPromptSubmit`, plus the first-run default `config.json` write
7. `README.md` — skills list updated with the 9 new entries; short pointer to `global/claude-review-loop/README.md`
8. `AGENTS.md` — unchanged (Skills section covers the pattern; hook layer is documented in `global/claude-review-loop/README.md`)

Size estimate summary:
- hook.sh: 700–900 lines of bash (includes ~30 lines of hardcoded default pattern arrays, ~100 lines of comments, preflight checks, grep-fallback machinery, and per-kind pattern-compile helpers for bash 3.2 compat)
- Each skill body: 15–30 lines
- README.md: ~400–600 lines
- setup.sh diff: ~60–80 lines added

## Explicit non-goals (documented, not implemented)

- **Fresh-context mode** — requires surgical message removal, which Claude Code does not expose.
- **Agent-facing tool** — the pi extension exposes a `review_loop` MCP-style tool for the agent to control the loop from within its own reasoning. In Claude Code, the equivalent would be an MCP server. Deferred to a follow-up; skills cover user-facing control, which is the primary use case.
- **Pattern overrides via settings at runtime** — the `config.json` schema includes `custom_*_patterns` fields, but the initial implementation reads them from config and applies `extend`/`replace` modes; there is no slash command to mutate them. Users edit `config.json` directly.
- **Per-project state** — state lives in `~/.claude/review-loop/`, not `<project>/.claude/`. Cwd guards prevent cross-project leakage; per-project state would add complexity without obvious benefit.

## Pre-implementation verification checklist

Before writing any code, install a ~20-line diagnostic hook into `~/.claude/settings.json` that logs every hook invocation (event name, stdin payload, stdout emitted). Run trivial Claude Code sessions that exercise each code path, then read the log to answer these questions:

1. **Exact `Stop` hook stdin JSON shape.** Keys, types, presence of `stop_hook_active`, whether `cwd` is `$PWD` or the session's original launch dir.
2. **Exact `UserPromptSubmit` hook stdin JSON shape.** Does it include a `prompt` field? What key name exactly?
3. **Does `UserPromptSubmit` fire on Stop-injected forced continuations?** (Case A vs Case B.) If yes:
   - What does `prompt` look like — identical to the `reason` string, wrapped with a system prefix, truncated, serialized differently?
   - **Timing**: how long after the Stop hook emits its block JSON does the UserPromptSubmit fire? Capture both timestamps in the diagnostic. If the gap exceeds the 2-second Case B time window, widen it or rely exclusively on the content check.
4. **Does the `reason` field of a blocked Stop actually reach the next assistant turn as context?** Verify by emitting a unique marker string and checking if Claude echoes it back in the next response.
5. **`stop_hook_active` lifetime.** Does it reset to `false` when a new user prompt arrives, or does it persist across multiple user turns if the hook keeps blocking?
6. **Does a transcript event or its metadata contain the `cwd`?** Needed for the session_id fallback lookup. If not present, the cwd-fallback strategy needs to be different. Dump a transcript file and inspect its schema.
7. **Does stdout from `UserPromptSubmit` actually get injected into Claude's context?** Verify by emitting a marker and checking Claude's next response. This is critical for the auto-trigger notice to work.
8. **Does Claude Code set any env vars when invoking the Bash tool?** Specifically `CLAUDE_SESSION_ID`, `CLAUDE_TRANSCRIPT_PATH`, `CLAUDE_PROJECT_DIR`, or similar. Test with a diagnostic skill body that runs `env | grep -iE '^claude|^anthropic'`. If any session-identifying env var exists, `resolve_session_id` can use it directly, eliminating both the pending-file heuristic and the two-concurrent-sessions limitation.
9. **Permission prompt UX.** Test running a `/review-start` skill that invokes `bash ~/.claude/hooks/review-loop.sh` with no prior permission rule in place. Confirm that the user is prompted once and that "always allow" persists across invocations. Confirm the exact pattern form the user should add to their `.permissions.allow` list.
10. **Does an env-var-prefixed command like `REVIEW_LOOP_FOCUS='...' bash ...` match a permission rule of the form `Bash(bash ...:*)`?** The permission matcher may or may not strip env var prefixes before pattern matching. If it doesn't, the recommended allow rule needs to account for the prefix (e.g., wildcard the prefix somehow) or the skill body needs to use a different invocation form (e.g., a wrapper script that reads focus from stdin, or passing focus as an argument despite the quoting hazards).
11. **Does the model see user text after a slash command when a skill fires?** When the user types `/review-start focus on error handling`, does Claude Code:
    - (a) substitute the skill body for the entire user prompt (args lost), or
    - (b) inject the skill body + the original prompt (model sees both), or
    - (c) expose args via a `$ARGUMENTS` placeholder in the skill body (skills don't currently support this per our plan's assumption)?

    If (a), the focus-text-extraction strategy in the skill body fails entirely. **Contingency**: move focus parsing into the `UserPromptSubmit` hook. Specifically:
    - The hook already sees the full prompt text in stdin. When it detects `/review-start` or `/review-plan`, use a regex to extract everything after the command name as the focus text: e.g., `focus=$(printf '%s' "$input_prompt" | sed -E 's|^/review-(start|plan)[[:space:]]*||')`.
    - Add a `focus` field to the pending file schema (non-delayed pending).
    - Extend `activate_core` to read focus from the pending file as a fallback when the env var `REVIEW_LOOP_FOCUS` is empty. Resolution order: env var → pending.focus → empty.
    - Skill body instructions get simpler: no more "look at the user's prompt". The body just runs `bash hook.sh activate code` and follows the printed output.

    This contingency should be **implemented regardless** of case (a/b/c), because even in case (b) the model may occasionally mis-parse the focus text. UserPromptSubmit parsing is the source of truth; env var is the override for advanced users.
12. **Does Claude reliably follow skill body instructions to run bash commands?** Do a smoke test with a skill that says "Run this bash command: `echo HELLO_FROM_SKILL`" and verify the model actually executes it on every invocation. Modern Claude models generally follow explicit instructions but this is worth confirming for our critical path.

The results feed directly into the hook script. Guessing risks shipping broken behavior. Items 3, 4, 6, 7, 8, 9, 10, 11, and 12 have no definitive docs — they must be verified empirically.
