---
name: github-issues
description: "Systematically triage, prioritize, and solve GitHub issues using git worktrees. Creates isolated branches per issue, plans before coding, commits along the way, and leaves PRs for human review."
---

# GitHub Issues Workflow

Systematically work through GitHub issues: triage, prioritize, create worktrees, plan, implement, commit, and stop before opening PRs.

## Overview

This skill covers the full lifecycle of working on GitHub issues:
1. **Triage** — List and prioritize open issues
2. **Setup** — Create an isolated git worktree per issue
3. **Plan** — Write PLAN.md before any code changes
4. **Implement** — Code, test, commit incrementally
5. **Wrap up** — Write RESULT.md, leave for human review (no PR)

## Phase 1: Triage & Prioritize

List open issues and assess them:

```bash
gh issue list --state open --limit 30 --json number,title,labels,createdAt \
  --jq '.[] | "#\(.number) [\(.labels | map(.name) | join(","))] \(.title)"'
```

**Good candidates** (work on these):
- Bug fixes with clear reproduction steps
- Documentation improvements
- Adding type hints
- Small, well-defined enhancements
- Issues labeled "good first issue"

**Skip these:**
- Architectural / breaking changes
- Issues labeled "blocked"
- Vague issues without clear acceptance criteria
- Issues requiring unavailable external services

If the project has an `ISSUE_PRIORITIES.md`, read it. Otherwise create one in the repo root with your ranked assessment before starting work.

## Phase 2: Create a Worktree

For each issue you decide to work on, create an isolated worktree and branch:

```bash
ISSUE=<number>
REPO_ROOT=$(git rev-parse --show-toplevel)
REPO_NAME=$(basename "$REPO_ROOT")
WORKTREE_PATH="${REPO_ROOT}/../${REPO_NAME}-issue-${ISSUE}"
BRANCH="issue-${ISSUE}"

# Fetch issue metadata
TITLE=$(gh issue view "$ISSUE" --json title --jq '.title')
BODY=$(gh issue view "$ISSUE" --json body --jq '.body')
LABELS=$(gh issue view "$ISSUE" --json labels --jq '[.labels[].name] | join(", ")')
COMMENTS=$(gh issue view "$ISSUE" --json comments --jq '.comments[].body' 2>/dev/null | head -c 2000)

# Create worktree (reuse branch if it exists)
if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git worktree add "$WORKTREE_PATH" "$BRANCH"
else
  git worktree add "$WORKTREE_PATH" -b "$BRANCH"
fi
```

Then write an `ISSUE_CONTEXT.md` in the worktree root containing the issue title, body, labels, and comments so the context is always at hand.

**If the project already has a `work_on_issue.sh` script**, use that instead of the manual steps above.

## Phase 3: Plan (PLAN.md)

Before writing any code, create `PLAN.md` in the worktree with:

1. **Understanding** — Restate the issue in your own words
2. **Acceptance criteria** — How we know it's done
3. **Affected files** — Which files need changes
4. **Approach** — Step-by-step implementation plan
5. **Testing strategy** — How to verify the fix
6. **Risks** — What could go wrong or is out of scope

## Phase 4: Implement & Commit Incrementally

Work inside the worktree directory. Follow any project-specific dev commands from `CLAUDE.md` or similar files (e.g. test runners, linters, formatters).

**Key rules:**
- Run tests early and often
- Run the formatter before every commit
- Commit in small, logical increments — don't batch everything into one giant commit
- Use conventional commit messages referencing the issue:
  - `fix(scope): description (closes #N)` for the final fix
  - `refactor(scope): extract helper for X` for intermediate steps
  - `test: add regression test for #N` for test-only commits

```bash
# Example commit flow
git add -A
git commit -m "test: add regression test for #42"
# ... more work ...
git add -A
git commit -m "fix(parser): handle empty input (closes #42)"
```

## Phase 5: Wrap Up

When done (or blocked), create `RESULT.md` in the worktree:

- What was done
- Which tests pass
- Any remaining concerns
- If blocked: why, and what's needed to unblock

**Do NOT open a PR.** The worktree and branch persist for human review. The human will create the PR when ready.

## Checking Status

To see all active issue worktrees:

```bash
git worktree list | grep "issue-"
```

To see detailed status of each:

```bash
PARENT=$(dirname "$(git rev-parse --show-toplevel)")
REPO_NAME=$(basename "$(git rev-parse --show-toplevel)")
for dir in "$PARENT"/${REPO_NAME}-issue-*; do
  [ -d "$dir" ] || continue
  NUM=$(basename "$dir" | grep -oP 'issue-\K\d+')
  echo "=== Issue #${NUM} ==="
  echo "Plan: $([ -f "$dir/PLAN.md" ] && echo 'yes' || echo 'no')"
  echo "Result: $([ -f "$dir/RESULT.md" ] && echo 'yes' || echo 'no')"
  git -C "$dir" log --oneline main..HEAD 2>/dev/null | sed 's/^/  /'
  echo
done
```

## Stop Conditions

Stop working and document in RESULT.md if:
- Same test fails 3+ times with different approaches
- Issue requires architectural changes beyond its scope
- Missing critical information — leave a comment on the issue asking for clarification
- No meaningful progress after extended iteration

## Multi-Agent Orchestration

Multiple pi sessions can work on different issues simultaneously. Each issue gets its own worktree and branch, so there are no git conflicts. Coordination uses three pi mechanisms:

- **Todos** — shared task board (`.pi/todos/`) visible to all sessions on the same machine
- **`list_sessions`** — discover live pi sessions and their names/IDs
- **`send_to_session`** — send messages to a running session, or query its status

### Architecture: Coordinator + Workers

One session acts as the **coordinator** (the session the user is talking to). It spawns **worker sessions** via tmux, one per issue, each running in its own worktree.

#### Coordinator Responsibilities
1. Triage and prioritize issues (Phase 1)
2. Create worktrees for selected issues (Phase 2)
3. Create a todo per issue for tracking
4. Spawn worker sessions via tmux
5. Monitor progress and report back to the user

#### Worker Responsibilities
1. Claim the todo for their assigned issue
2. Read `ISSUE_CONTEXT.md` in the worktree
3. Write `PLAN.md`, implement, test, commit
4. Write `RESULT.md` when done
5. Update the todo status to `done` (or `blocked`)

### Step 1: Create Todos for Tracking

Use the `todo` tool to create one todo per issue. This gives all sessions a shared view of what's in progress.

```
todo(action="create", title="Issue #42: Fix parser crash on empty input", status="open", tags=["issue", "issue-42"])
todo(action="create", title="Issue #43: Add type hints to utils", status="open", tags=["issue", "issue-43"])
```

### Step 2: Create Worktrees

Create a worktree per issue as described in Phase 2. Each worker will operate exclusively in its worktree.

### Step 3: Spawn Workers via tmux

Pi is an interactive TUI — it cannot be backgrounded directly. Use **tmux** to spawn each worker in its own pane. Read the `tmux` skill for full details on socket conventions and safe input sending.

```bash
# Set up tmux socket (per tmux skill conventions)
SOCKET_DIR=${TMPDIR:-/tmp}/claude-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/claude.sock"

# Spawn a worker for issue #42
WORKTREE="/path/to/repo-issue-42"
tmux -S "$SOCKET" new -d -s issue-42 -c "$WORKTREE"
```

Then start pi inside the tmux session with an initial prompt. The prompt must tell the worker to:
1. Set its session name with `/name` (so the coordinator can address it by name later)
2. Claim its todo
3. Do the work

```bash
# Start pi with initial instructions inside the tmux session
tmux -S "$SOCKET" send-keys -t issue-42 "pi \"/name issue-42\" \"Read ISSUE_CONTEXT.md and solve this issue. Claim TODO-<id> before starting. When done, update the todo to done and write RESULT.md. Do not open a PR.\"" Enter
```

**Important:** The `/name issue-42` message sets the pi session's display name. This is what makes the session addressable via `send_to_session(sessionName="issue-42")`. Without it, you must use the session's UUID from `list_sessions` instead.

Repeat for each issue. Tell the user how to monitor tmux:

```
To watch a worker yourself:
  tmux -S /tmp/claude-tmux-sockets/claude.sock attach -t issue-42
Detach with Ctrl+b d.
```

### Step 4: Monitor Progress

The coordinator has several ways to check on workers:

**Check which pi sessions are alive and named:**

Use the `list_sessions` tool. This returns all live pi sessions that expose a control socket, along with their names (set via `/name`) and session IDs.

**Get a summary of what a worker has been doing:**

```
send_to_session(sessionName="issue-42", action="get_summary")
```

This returns a summary of the worker's activity since the last user prompt — what tools it called, what files it changed, etc. No message is sent to the worker; it's a read-only query.

**Read the worker's plan or result directly:**

```
read("/path/to/repo-issue-42/PLAN.md")
read("/path/to/repo-issue-42/RESULT.md")
```

**Check commits on the worker's branch:**

```bash
git -C /path/to/repo-issue-42 log --oneline main..HEAD
```

**Check the shared todo board:**

```
todo(action="list")
```

Workers update their todo status as they progress (`in-progress` → `done` or `blocked`), so the todo board gives a quick overview.

**Send a message to a worker (e.g. to nudge or redirect):**

```
send_to_session(sessionName="issue-42", message="What's your current status? Reply to the sender session.")
```

Note: `send_to_session` with `action="send"` delivers a message that interrupts the worker's current turn (steer mode) or waits until it finishes (follow_up mode). Use `wait_until="turn_end"` if you want to block until the worker responds.

### Step 5: Collect Results

When a worker finishes:
- Its todo status is `done`
- `RESULT.md` exists in the worktree
- Commits are on the `issue-N` branch

The coordinator reads `RESULT.md` from each worktree and summarizes results for the user. The worktrees and branches persist for human review. **No PRs are opened.**

### Cleanup

When the user is satisfied and has reviewed the worktrees:

```bash
# Kill all worker tmux sessions
tmux -S "$SOCKET" kill-server

# Worktrees and branches persist for the human to review, push, and PR
```

### When a Worker Gets Stuck

If a worker hits a stop condition, it should:
1. Write `RESULT.md` explaining the blocker
2. Update its todo to `blocked` with details in the body:
   ```
   todo(action="update", id="TODO-abc123", status="blocked", body="Tests fail because X depends on Y which is not available in the test environment.")
   ```
3. Stop working

The coordinator can then:
- Report the blocker to the user for guidance
- Send new instructions to the worker: `send_to_session(sessionName="issue-42", message="Try approach X instead.")`
- Or mark the issue as deferred and move on

### Avoiding Conflicts

- **One issue per worktree** — git branches are isolated, no merge conflicts between workers
- **Claim todos before starting** — use `todo(action="claim", id="TODO-xxx")` to prevent two sessions from picking the same issue
- **No shared file edits** — workers only modify files in their own worktree
- **No PRs** — workers commit to their branch but never push or open PRs; the human does that after review

### Limits and Expectations

- Workers are independent pi sessions with their own context windows. They can hit compaction, rate limits, or context overflow just like any session.
- The coordinator cannot see a worker's full conversation — only summaries via `get_summary`, files on disk, and todo updates.
- If a worker's pi session crashes or disconnects, its tmux session will still exist (showing the exit). The coordinator can detect this because `list_sessions` will no longer show the session. Restart by sending a new `pi` command into the same tmux session.
- For very large issues, a single worker may exhaust its context. The `PLAN.md` → incremental commit approach helps: even if the session dies, progress is preserved in git commits.
