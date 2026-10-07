# Changelog

All notable changes to agent-stuff are documented here.

## Unreleased

* Added `figure-design` skill: whiteboard-style design of conceptual figures:
  - ASCII concepts before any drawing;
  - text-free drafts, one version per turn;
  - a palette derived from `.pymolrc`, with line shades;
  - `tools/look.py` (rasterize and lint) and `tools/preview.py` (live-reload viewer).
* Added `interactive-figures` skill: single interactive scientific figures as one offline HTML file:
  - D3/SVG and Mol*/MolViewSpec templates sharing a state contract (URL hash, arrow-key states, talk mode, iframe auto-height);
  - `tools/check.py`: screenshots every state, checks the contract, accessibility and offline use, and exports pixel-verified SVG stills;
  - `tools/bundle.py`: inlines libraries and data;
  - `tools/preview.py`: live-reload viewer.
* `pymol-pml-scripting` and `interactive-textbook` now point to the new figure skills.
* Migrated extensions for pi 0.62.0 breaking changes:
  - Replaced `getEditorKeybindings()` with `getKeybindings()` in todos and files extensions.
  - Updated all keybinding IDs to namespaced format (e.g. `"selectConfirm"` → `"tui.select.confirm"`, `"expandTools"` → `"app.tools.expand"`).
  - Fixed `renderCall`/`renderResult` in loop extension to return empty `Container` instead of `undefined`.
  - Updated command provenance access from `c.path` to `c.sourceInfo.path` in context extension.
* Added notify extension fallback channels for Kitty (OSC 99), Windows toast, and webhook delivery for remote/headless sessions.
* Added notify webhook setup examples for Slack, ntfy, and Pushover in the README.

## 1.2.0

* Updated pi-extensions to use the new `ToolDefinition.execute` parameter order.
* Fixed notify extension notifications to render plain Markdown.

## 1.1.1

* Removed the deprecated `qna` extension.
* Added `uv` extension and skill for uv integration.

## 1.1.0

* Added project review guidelines and preserved review state across navigation.
* Added the `/diff` command to the unified file browser and merged diff/file workflows.
* Added new skills for commits, changelog updates, and frontend design.
* Expanded the whimsical "thinking" messages.
* Added prompts directory configuration support for Pi.
* Fixed reveal shortcut conflicts and improved the PR review editor flow.

## 1.0.5

* Fixed the release CI pipeline for the published package.

## 1.0.4

* Added the session control extension with socket rendering, output retrieval, and copy-todo text actions.
* Added support for session names and custom message types in session control.
* Improved control socket rendering and reconnection handling.
* Added control extension documentation.

## 1.0.3

* Added todo assignments and validation for todo identifiers.
* Added copy-to-clipboard workflows for todos and improved update UX.
* Switched answer tooling to prefer Codex mini and refined prompt refinement.
* Documented todos and refreshed README guidance.

## 1.0.2

* Introduced the todo manager extension (list/list-all, update, delete, and garbage collection).
* Added TODO-prefixed identifiers and refined the todo action menu behavior.
* Improved todo rendering and the refinement workflow ordering.
* Added support for append-only updates without requiring a body.
* Removed the unused codex-tuning extension.

## 1.0.1

* Added core extensions: /answer (Q&A), /review, /files, /reveal, /loop, and cwd history.
* Added skills for Sentry, GitHub, web browsing, tmux, ghidra, pi-share, and Austrian transit APIs.
* Added Pi themes including Night Owl and additional styling.
* Added and refined the commit extension and review workflow.
* Improved packaging and initial repository setup.
