# Behavioral Guidelines

Reduce common LLM coding mistakes. Biased toward caution over speed — for trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

# Git Commit Rules

Use Conventional Commits: `<type>(<scope>): <summary>`
- Types: feat, fix, docs, refactor, chore, test, perf
- Summary: imperative, <= 72 chars, no trailing period
- Only commit, never push unless asked
- If unclear which files to include, ask

# Python

- Prefer pixi in projects with pixi.toml; prefer uv otherwise
- Never use pip/pip3/conda directly
- Run python via `pixi run python` or `uv run python`

# imbue-code-guardian skills in Delta

Skip this section in Claude Code and Codex. When running `autofix`, `verify-architecture`, `verify-conversation` or `reviewer-init-categories` in Delta:
- `${CLAUDE_PLUGIN_ROOT}` is not set. Substitute `/Users/kyroyo/.claude/plugins/marketplaces/imbue-code-guardian/plugins/imbue-code-guardian` wherever it appears.
- "Spawn a `<name>` Agent" means spawn a fresh Delta subagent whose instructions are the contents of `<plugin root>/agents/<name>.md` plus the inputs the skill lists, then wait for it to finish. Use the current model; ignore `haiku`, `opus` and `opus[1m]`. If you cannot spawn subagents, say the review cannot run; never review it yourself or write a pass marker.
- Ignore `allowed-tools` frontmatter. `AskUserQuestion` means ask the user. `$ARGUMENTS` means the user's request.
- `verify-conversation`: skip `export_transcript_paths.sh`, `filter_transcript.py` and `progress.jsonl` (they only read Claude Code and Codex logs). Instead tell the `review-conversation` subagent to read the transcript with `delta thread show "<thread id>"` (JSON; the `messages` field holds the conversation), passing it the value of `$DELTA_CURRENT_THREAD_ID`, and to review the whole thread. If that variable is empty, find the thread with `delta thread list --json` and confirm it with the user.
