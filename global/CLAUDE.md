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
