# oh-my-pi inspired Pi extensions design

## Context

This repo stays on the current Pi runtime. The goal is not to port oh-my-pi wholesale. The first pass adds small, compatible Pi extensions and skill updates inspired by selected oh-my-pi features, with explicit follow-up debt for parity and dependency removal.

## Goals

- Keep using the existing `pi` binary and extension APIs from this repo.
- Add MVP-usable tools for web search, zmx-backed subagents, hashline edits, simple AST rewrites, and lightweight LSP workflows.
- Prefer thin wrappers around existing binaries/APIs over vendoring large oh-my-pi subsystems.
- Allow temporary npm dependencies, including `@oh-my-pi/hashline`.
- Document the work needed to remove oh-my-pi dependencies later.

## Non-goals

- Do not replace the current Pi runtime with oh-my-pi.
- Do not vendor large oh-my-pi core subsystems.
- Do not implement a full OMP-compatible task lifecycle, async job manager, LSP JSON-RPC stack, or native AST backend in phase 1.
- Do not implement full Zed ACP in phase 1 unless a tiny bridge is discovered during implementation.

## Recommended approach

Use a phased MVP:

1. Add one project-local extension at `.pi/extensions/omp-lite.ts`.
2. Add helper modules under `.pi/extensions/lib/omp-lite/` only when the extension becomes too large for one file.
3. Add npm dependencies in `.pi/extensions/package.json` only when they provide real leverage.
4. Update skills and README so agents use the new tools naturally.
5. Record parity gaps and dependency-removal debt in the final summary.

This keeps the diff small and leaves clean seams for later replacement.

## Components

### `web_search` tool

A new Pi tool named `web_search` replaces the current `native-web-search` skill workflow for day-to-day use.

MVP behavior:

- Input: `query`, optional `recency`, optional `limit`.
- Provider order: use keyed providers when env vars are present; otherwise fall back to DuckDuckGo HTML search.
- Output: concise answer/source list when the provider supplies answers, otherwise source titles, URLs, and snippets.
- Failure mode: return a normal tool result with a clear error instead of throwing for missing providers.

The first pass can be simpler than OMP's provider chain. Provider richness is follow-up work.

### `subagent` tool

A new Pi tool named `subagent` delegates work to named worker sessions through `zmx`.

MVP behavior:

- Input supports a single task and a small batch of independent tasks.
- Each worker runs in its own zmx session with a stable generated name.
- Workers invoke `pi --session-control`, set `/name`, and receive a self-contained assignment.
- Return value lists worker names plus monitoring commands: `zmx history`, `zmx attach`, and `zmx kill`.
- The tool does not try to collect final worker output in phase 1; coordination uses existing `send_to_session`, `list_sessions`, and zmx tools.

This integrates with the existing `skills/zmx` guidance instead of duplicating OMP's task registry.

### `hashline_edit` tool

A new Pi tool named `hashline_edit` applies hashline patches using `@oh-my-pi/hashline`.

MVP behavior:

- Input: a hashline patch string.
- Use the package's filesystem and patcher primitives where possible.
- Keep the tool separate from the built-in `edit` tool to avoid overriding Pi's current exact-replacement behavior.
- Return applied section summaries and errors from the hashline patcher.

If the package requires a snapshot store that Pi's normal `read` output does not provide, phase 1 may add a companion `hashline_read` or a lightweight session-local snapshot recorder.

### `ast_edit` tool

A new Pi tool named `ast_edit` provides MVP structural rewrites.

MVP behavior:

- Input: `paths` plus rewrite operations with `pat` and `out`.
- Use the `ast-grep` CLI when available.
- Fail clearly with an install hint when `ast-grep` is missing.
- Preview-first is preferred if simple; direct apply is acceptable only with a small, explicit safety check.

This is inspired by OMP's native AST editing but intentionally avoids native bindings in phase 1.

### `lsp` tool and options

A lightweight `lsp` tool exposes useful language-server checks without porting OMP's LSP stack.

MVP behavior:

- Support a project/user config shape inspired by OMP's `lsp.json`.
- Actions: `status`, `config`, and simple `diagnostics` where a configured command can be run safely.
- Auto-detect common servers by root markers and executable availability when no config exists.
- Do not maintain long-lived JSON-RPC LSP processes in phase 1.

Full navigation, rename, hover, and code actions are parity debt.

### Zed ACP

Phase 1 records the ACP design but does not build it unless implementation reveals a tiny path.

Likely future shape:

- A small Node CLI that speaks the Agent Client Protocol and proxies to `pi --mode rpc`.
- Map ACP session lifecycle to Pi RPC commands (`prompt`, `abort`, `get_state`, `get_messages`).
- Map Pi streaming events to ACP updates.
- Route permission prompts through Pi RPC extension UI where possible.

This is a standalone bridge, not a Pi extension.

## Skills and docs updates

- Replace or deprecate `skills/native-web-search` with guidance for the new `web_search` tool.
- Update `skills/zmx` to describe the `subagent` tool as the first-class worker-spawn path.
- Update `README.md` extension and skills lists.
- Keep `setup.sh` mostly unchanged because it already auto-discovers `.pi/extensions/*.ts` and installs `.pi/extensions/package.json` dependencies.

## Error handling and safety

- Tools should return clear text errors for missing optional dependencies or providers.
- `subagent` should never background bare `pi` processes; it must use zmx.
- `hashline_edit` and `ast_edit` must avoid partial writes where practical.
- Any tool that mutates files should participate in Pi's file mutation queue when available.
- Network search should include source URLs and should not invent citations.

## Verification

- Run `npm install` in `.pi/extensions/` after dependency changes.
- Run a TypeScript/import smoke check for `.pi/extensions/omp-lite.ts`.
- Run a Pi extension smoke check if available, for example loading the extension with `pi -e .pi/extensions/omp-lite.ts --help` or an equivalent no-op invocation.
- Test non-network behavior without requiring external API keys.
- Test `web_search` against DuckDuckGo only when network is available.
- Test `subagent` with a tiny no-op assignment in a disposable zmx session.
- Test mutating tools on temporary files.

## Follow-up debt

### Parity debt

- Add richer web-search provider fallback matching more of OMP's provider chain.
- Add real LSP JSON-RPC support for hover, definition, references, rename, and code actions.
- Add preview/apply workflow for `ast_edit` if phase 1 lands direct apply only.
- Add subagent output collection, artifact links, lifecycle status, and follow-up messaging shortcuts.
- Build the Zed ACP bridge as a separate CLI once the MVP tools are stable.

### Removing oh-my-pi dependencies

- Replace `@oh-my-pi/hashline` with a small local hashline subset if the repo only needs basic `SWAP`, `DEL`, and `INS` operations.
- Replace any OMP-specific package imports with current-Pi equivalents or local helpers.
- If `ast-grep` CLI becomes a hard requirement, decide whether to keep it as an external binary or replace it with language-specific simpler rewrites.
- Keep a narrow compatibility wrapper so future removal is isolated to `.pi/extensions/lib/omp-lite/` and does not affect skills or setup.
