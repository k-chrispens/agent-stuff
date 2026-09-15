---
name: identify-bad-tests
argument-hint: [target_path]
description: Identify low-quality or fragile tests (weak/tautological assertions, missing cases, mock misuse, flakiness, mis-placement) under the $1 path
---

The argument `$1` is the path to scan. It may be an entire project or library (e.g. `libs/mngr`, `packages/core`, or just the bare name `mngr`), a repo root, or any subdirectory within one (e.g. `libs/mngr/cli`), so you can scope this skill narrowly to part of a codebase when that is all you care about.

Before doing anything else, resolve these things from `$1` and state them explicitly:

- **The repo root**: the directory containing the checkout (look for `.git/` upward from `$1`). All context files (style guide, agent instructions, non-issues docs) are discovered relative to this.
- **The scan scope**: the directory tree you will examine. This is `$1` itself, resolved to a real path. (If `$1` is a bare project name like `mngr`, resolve it to the directory that contains it -- check common parents like `libs/`, `packages/`, `apps/`, `modules/`, `src/`, or fall back to the repo root and search for a matching directory.) You must only report findings for code under this path.
- **The containing project**: the project directory that owns the scan scope, for deciding where to write the output file. Detection order:
  1. If the repo uses a monorepo layout where projects live at a fixed two-component prefix (e.g. `libs/<name>`, `packages/<name>`, `apps/<name>`), the containing project is exactly that prefix of the scan-scope path (e.g. for a scan scope of `libs/mngr/cli`, the containing project is `libs/mngr`).
  2. Otherwise, the containing project is the smallest ancestor of the scan scope that has its own build/package manifest (`pyproject.toml`, `package.json`, `Cargo.toml`, `setup.py`, `BUILD`, etc.).
  3. If no per-project structure exists, the containing project is the repo root itself.

## Gathering context: what a good test looks like here

Every repo encodes its testing bar in slightly different files. Before reviewing, find and read whichever of these exist, and say which ones you found:

1. **Style guide** -- look for `style_guide.md`, `STYLE_GUIDE.md`, `CONTRIBUTING.md`, `docs/style*.md`, or a docs/wiki page the repo's README points to for testing guidance. Read any testing or test-quality sections closely.
2. **Agent instructions** -- `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `GEMINI.md`, or equivalent at the repo root (and per-project versions if in a monorepo). Note any test conventions stated there (e.g. rules like "skip `_test.py`/`test_*.py` files when reading code" do NOT apply here -- test files are what you are reviewing).
3. **Non-issues documents** -- look for any file the style guide or agent instructions name as listing known non-issues or accepted patterns (commonly `non_issues.md` at repo root or per-project, or a section inside the docs themselves). Do not report anything these call out as a non-issue.
4. **Downstream-tooling contracts** -- if the style guide or agent instructions mention tools that consume quality-audit reports (e.g. fixme generators, issue updaters, output location or format expectations), note them now; you need the output file to land where they expect.

Then find and read the test files in the scan scope in full. Tests may live in a dedicated `tests/` or `test/` module, co-located as `*_test.py` / `test_*.py` / `*.test.ts` / `*_test.go` files next to source, or both. Include:

- The **entire test tree** under the scan scope, however it is organized.
- The **`conftest.py` chain** (or equivalent shared-setup files -- `tests/conftest.py`, `setup_test.go` helpers, `jest.setup.js`, fixtures modules) from repo root down to the scan scope, paying particular attention to **autouse / global / shared fixtures and setup hooks**. These establish the isolation, environment, and safety baseline that every test in scope inherits for free (e.g. redirecting HOME to a temp path, a unique per-test prefix, failing on unexpected warnings, database rollback). Knowing what tests get automatically tells you both what a test should not be re-implementing by hand and which conventions it is expected to follow. (This mostly helps you *avoid false positives* -- confirming what isolation is already automatic so you don't flag a test for "missing" setup it inherits -- more than it generates findings. Fixtures are also sometimes registered through a shared `testing.py`-style helper module rather than defined in `conftest.py` directly, so follow those registrations.)
- **Shared test helpers** -- `testing.py`, `mock_*_test.py`, `tests/helpers/`, `testutils/` packages, and any shared fake/mock implementations. You will need these to tell a real shared mock implementation from an ad-hoc fake.

You don't need to read all of the production code up front; instead get a sense of what the containing project is meant to do (its README and docs), and drill into the specific production code a test exercises whenever you need that detail to judge whether the test actually verifies the right behavior.

Once you've gathered that context, please do the below.

Your task is to identify tests within the scan scope that are low-quality, fragile, or misleading -- tests that pass without establishing that the code is correct, that break for reasons unrelated to real bugs, or that are placed or structured wrongly. A bad test is worse than no test: it costs CI time and maintenance, and it lulls readers into thinking a behavior is covered when it is not.

The context files you read above define what a good test looks like in this repo; use them as the standard and find where the tests in scope fall short. Focus on semantic quality, the things a linter or ratchet cannot see. Many repos have automated ratchets or linters that already count raw occurrences of `unittest.mock`, `monkeypatch.setattr`, `time.sleep`, and inline imports (e.g. a `test_ratchets.py`, an eslint rule, or a CI lint step) -- if you find one, do not report those raw-usage findings on their own. Do report the semantic damage when one of those patterns makes a test meaningless -- e.g. a mock that fakes out the very thing under test -- describing what is wrong with the test, not merely that it "uses a mock".

## How to judge each test

Judge every test along two axes.

**Does it actually verify behavior?** This is the heart of it. For each test or assertion, ask:

1. **Would it catch a real bug?** Name the concrete bug -- a specific wrong value, a swapped branch, a dropped side effect -- the test should guard against, and check that its assertions would actually fail on it. If you cannot, or they would still pass, it is a candidate. Exercising the code is not the same as verifying it. (Tautological assertions, "it didn't raise" with no check on the result, and loose coverage-chasing assertions all fail here.)
2. **Behavior or implementation?** Would a behavior-preserving refactor break it? Then it is coupled to implementation details (internal call order, private attributes, how a result was computed) and is a candidate; good tests assert on observable effects.
3. **Could it fail for the wrong reasons?** Sleep-based synchronization, non-unique IDs, shared state, order-dependence, real network access, or anything not self-isolating makes it flaky -- flag it.

**Is it well-formed and properly structured?** Flag divergences from the repo's stated conventions (style guide + agent instructions): wrong test type, location, or marker for the dependencies it actually uses; classes used to group test functions where the convention is module-level; undescriptive names; misuse of `parametrize` (or table-test equivalents); missing edge / branch / empty-collection cases; snapshot misuse (hand-written expected values that just duplicate the code, or oversized inline snapshots that should be hashed); and fixture problems -- a test that hand-rolls setup a shared fixture already provides instead of reusing it, or defines fixtures in the test file rather than in the shared conftest/setup file.

## Reporting

For each finding, the `Recommendation` should be a concrete fix, e.g.: rewrite the assertion to check the operation's effect (with the specific value/snapshot to assert); add the missing empty/boundary/branch case; replace the inline fake with the shared mock/helper implementation or a real object; make IDs unique with `uuid4().hex` or the language equivalent; replace sleep-based synchronization with polling on a condition; move the test to the correct file/marker for its type; or split a class-grouped test into module-level `test_` functions. If a flagged test turns out to be adequate, recommend the brief clarifying comment that explains why (e.g. why this assertion is sufficient, or why a loose bound cannot be tightened without making the test flaky).

Do NOT report issues that are already covered by an existing TODO/FIXME comment in the code.

Do NOT report issues that are listed as non-issues in the non-issues documents you found.

After reviewing all the tests in the scan scope, think carefully about the most important and most misleading ones (a test that silently passes on a real bug is worse than one that is merely redundant).

Then put them, in order from most important to least important, into a markdown file in the containing project's output folder. Resolution order for that folder:

1. If the context files you read specify an output location or a downstream tool expects one (e.g. "_tasks/bad-tests/" under the containing project), use exactly that.
2. Otherwise, default to the containing project's `_tasks/bad-tests/` folder (create it if you have to) -- always the containing project's folder, even when the scan scope was a subdirectory, so findings live where project-level quality outputs are expected.

Name the file "<date>.md" (where you should get "date" by calling this precise command: "date +%Y-%m-%d-%T | tr : -")

For the format of the file, use the following:

```markdown
# Bad tests under <scan scope> (identified on <date>)
## 1. <Short description of the bad test>

Description: <detailed description, including file names, test function names, and line numbers, of what the test does, why it is bad (which of the three questions it fails), and what real bug it fails to catch or what unrelated reason it would break for>

Recommendation: <the concrete fix, or, if the test is actually adequate, the clarifying comment to add and what it should say>

Decision: Accept

## 2. <Short description of the bad test>

Description: <detailed description of the bad test, including file names, test function names, and line numbers where applicable>

Recommendation: <your recommendation for how to fix it, or the clarifying comment to add>

Decision: Accept

...
```

The `Decision` field is a triage marker that downstream tooling may read -- its values are `Accept` / `Reject` / `Pending`. Default every finding to `Accept`; it records "this should be fixed", not your confidence, and whoever triages the file flips entries to `Reject` or `Pending` as needed. Convey relative importance through the ordering (most important first), not this field.

There's no need to commit when you're done. Just be sure to create the file in the right location with the right content.
