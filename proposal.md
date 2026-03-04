# Proposal: Pi Skill & Extension Modernization (Staff Review Revision)

## Executive Summary
This revision prioritizes **correctness**, **incremental delivery**, and **low-risk wins first**. The existing proposal had strong ideas, but a few recommendations were too absolute or mismatched with the current repo/runtime setup.

The highest-value near-term work is:
1. Adopt `promptSnippet` + `promptGuidelines` for noisy tools.
2. Remove low-value loop transcript noise (`signal_loop_success`).
3. Fix stale runtime behavior in `uv.ts` and `pixi.ts`.

The vim/input and skill-location changes are still good opportunities, but should be staged carefully.

---

## 1) Scope, Assumptions, and Constraints

### In scope
- Extensions in `.pi/extensions/`:
  - `todos.ts`, `control.ts`, `loop.ts`, `uv.ts`, `pixi.ts`, `vim.ts`, `pdf-reader/index.ts`
- Skill strategy for this repository.

### Assumptions
- Target runtime is Pi `0.55.4+` (for dynamic tool refresh and prompt APIs).
- We should preserve backward-safe behavior where practical.

### Constraint correction (important)
- The terminal input API is exposed via **`ctx.ui.onTerminalInput(...)`**, not `pi.on("terminal_input", ...)`.
- This repo currently contains distributable skills in `skills/`; recommending a full move to `.agents/skills` would break packaging/workflow unless done as an additive strategy.

---

## 2) Current-State Findings (Audited)

1. **Tool prompt bloat**
   - `todos.ts`, `control.ts`, `loop.ts`, and `pdf-reader/index.ts` contain long, instruction-heavy `description` fields.

2. **Stale Python interceptor behavior**
   - `uv.ts` and `pixi.ts` decide activation once at load/startup and register a `bash` override statically.
   - If project state changes during a session (e.g., creating/removing lock/config files), behavior can be stale.

3. **Vim extension tightly coupled to custom editor replacement**
   - `vim.ts` relies on `ctx.ui.setEditorComponent(...)`, which is powerful but invasive and increases maintenance surface.

4. **Loop control tool creates low-signal transcript output**
   - `signal_loop_success` is primarily control flow; its transcript footprint can be suppressed for cleaner UX.

5. **Skill location recommendation needs nuance**
   - The previous proposal treated global skills as the only source of truth. In this repo, `skills/` is a first-class distributable path.

---

## 3) Prioritized Recommendations

| Priority | Recommendation | Impact | Risk |
|---|---|---:|---:|
| P0 | Add `promptSnippet` + `promptGuidelines` to key tools | High | Low |
| P0 | Suppress transcript output for `signal_loop_success` | Medium | Low |
| P1 | Refactor `uv.ts` + `pixi.ts` for runtime-correct interception | High | Medium |
| P1 | Introduce `ctx.ui.onTerminalInput` path for vim (incrementally) | Medium | Medium/High |
| P2 | Additive `.agents/skills` strategy (not wholesale move) | Medium | Low |

---

## 4) Detailed Plan

### P0.1 Tool prompt hygiene (`promptSnippet` / `promptGuidelines`)

**What to change**
- Keep `description` concise and factual.
- Move operational behavior guidance into:
  - `promptSnippet`: one-line tool summary for "Available tools".
  - `promptGuidelines`: behavioral bullets for "Guidelines".

**Where**
- `.pi/extensions/todos.ts`
- `.pi/extensions/control.ts` (`send_to_session`, `list_sessions`)
- `.pi/extensions/loop.ts`
- `.pi/extensions/pdf-reader/index.ts`

**Why**
- Better instruction locality and readability in system prompt.
- Lower chance of missing critical usage guidance inside long descriptions.

---

### P0.2 Suppress loop signal transcript clutter

**What to change**
- In `signal_loop_success` tool (`.pi/extensions/loop.ts`), implement custom renderers that return `undefined` (or empty component) for call/result when successful control signaling is enough.

**Why**
- This tool is orchestration-only and tends to add noise to interactive transcripts.
- Pi `0.55.4` explicitly improved support for zero-footprint custom renders.

---

### P1.1 Fix stale runtime behavior in `uv.ts` / `pixi.ts`

**Problem**
- Current implementation evaluates project type once and conditionally registers a `bash` override.

**Recommended approach (more robust than registration-only toggling)**
- Register a single override tool that decides on each execution whether interception should apply.
- Delegate to:
  - intercepted bash (`PATH` prefixed) when enabled and project detection matches,
  - plain bash otherwise.

**Why this approach**
- Correct even if project markers appear/disappear mid-session.
- Avoids repeated register/unregister complexity and ordering pitfalls.

**Alternative**
- Dynamic `pi.registerTool()` in `session_start`/command handlers is now viable in `0.55.4`, but by itself still won’t react to file changes unless additional triggers are wired.

---

### P1.2 Vim modernization using terminal interception (incremental)

**Correction**
- Use `ctx.ui.onTerminalInput(...)` hooks.

**Incremental rollout**
1. Keep current `setEditorComponent` path as default.
2. Add an opt-in experimental mode using terminal interception for a subset of keys (e.g., `Esc`, normal-mode movement).
3. Expand only after parity checks on history, autocomplete, and app-level keybindings.

**Why incremental**
- Rewriting full vim behavior in one shot is high risk and user-visible when it regresses.

---

### P2 Skill location strategy (additive, not destructive)

**Do not** blindly move repository skills out of `skills/`.

**Instead**
- Keep canonical distributable skills in `skills/`.
- Optionally add project-specific overrides in `.agents/skills/` where local policy differs.
- For overlapping names, document precedence and intent.

**Why**
- Preserves package behavior while enabling project-local customization.

---

## 5) Validation Plan

### Functional checks
1. **Prompt/tooling checks**
   - Confirm updated tools appear with expected `promptSnippet` and guideline bullets.
2. **uv/pixi checks**
   - Start in non-uv project, create `pyproject.toml`/`uv.lock`, verify behavior switches without reload.
   - Verify `--no-uv` / `--no-pixi` still honored.
3. **vim checks**
   - Validate insert/normal transitions and app keybindings (`ctrl+c`, `ctrl+d`, escape handling).
4. **loop checks**
   - Ensure loop still exits correctly and transcript noise is reduced.

### Regression checks
- No broken tool schemas.
- No command name conflicts.
- No degraded behavior in non-interactive/RPC modes.

---

## 6) Rollout and Risk Mitigation

### Rollout order
1. P0 prompt hygiene
2. P0 loop render cleanup
3. P1 uv/pixi runtime refactor
4. P1 vim experimental interception
5. P2 additive skill overrides

### Mitigations
- Land changes in small PRs.
- Keep feature flags/toggles for vim behavior while stabilizing.
- Maintain fallback path for uv/pixi delegation.

---

## 7) Final Recommendation

Proceed with **P0 immediately** and start **P1 uv/pixi** next. Treat vim modernization as an **incremental experimental track**, and handle skill-location updates as an **additive override strategy** rather than a migration.

This sequencing delivers meaningful gains quickly without destabilizing daily workflows.