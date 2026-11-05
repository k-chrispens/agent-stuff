---
name: rex-review
description: "Code review and diff viewing in the Rex terminal with nvim (diffview.nvim, octo.nvim) and gh. Use whenever the user, inside Rex, wants to review a PR or branch, see a diff, look at GitHub PR comments or review threads, open a review/diff tab, or jump their editor to a finding — even if they don't say 'Rex' or 'nvim' explicitly. Also use when changing this review setup (nvim config in ~/dotfiles/nvim)."
---

# Code review in Rex

The setup: Rex panes run terminal programs only (no built-in diff viewer). Reviewing happens in
nvim (kickstart-based config) with **diffview.nvim** for git diffs and **octo.nvim** for GitHub
PRs, both talking to git/`gh`. Load the `rex` skill for general Rex commands.

## Split the work: you read with `gh`, the user looks in nvim

Get review data for yourself from `gh`, not by driving the user's editor. Screen-scraping nvim
through `rex capture` is lossy (only the visible screen, no scrollback) and keystrokes sent
through Rex are not always delivered as expected. Use Rex + nvim to *show* things to the user.

```sh
gh pr view 123 --json title,body,reviewDecision,files
gh pr diff 123
# Inline review comments (file:line:author: body). `line` is null on outdated comments.
gh api 'repos/{owner}/{repo}/pulls/123/comments' --paginate \
  --jq '.[] | "\(.path):\(.line // .original_line):\(.user.login): \(.body | gsub("\n"; " "))"'
gh pr view 123 --comments   # conversation (non-inline) comments
```

For finding bugs, use `/code-review` or `/adversarial-review` rather than an ad-hoc read.

## Show the user

Open a new tab in the user's session; `-c` must be a clone of the relevant repo (octo infers the
GitHub repo from the git remote).

```sh
# Local changes or a branch
rex window new -s "$REX_SESSION" Diff -c "$repo" --json -- nvim +'DiffviewOpen main...'
# A PR with its review threads (read-only view)
rex window new -s "$REX_SESSION" 'PR 123' -c "$repo" --json -- nvim +'Octo pr edit 123'
```

Save `.block_ids[0]`. Wait ~3–8 s, then `rex capture --trim` to confirm it rendered.

**Jump nvim to a finding** (escape first so text isn't typed into insert mode or a prompt):

```sh
rex send-key -s "$REX_SESSION" -b "$ed" escape
rex send -s "$REX_SESSION" -b "$ed" ':e +42 src/foo.py' && rex send-key -s "$REX_SESSION" -b "$ed" enter
```

Prefer ex commands (`:480`, `:e +N file`) over control-key motions: during setup a `ctrl+b` sent
through Rex did not scroll nvim. Never send input to your own pane (`$REX_BLOCK`).

## Ask before anything that posts to GitHub

These are visible to collaborators and some can't be undone, so only do them when the user
explicitly asks: `:Octo review start` (creates a pending review under their name), review submit,
approve/request changes, adding or replying to comments, resolving threads, merging, and the `gh`
equivalents (`gh pr review`, `gh pr comment`, `gh pr merge`). Opening and reading are fine.

## Gotchas

- diffview shows `Changes (0)` while it is still loading; re-capture before concluding it's empty.
- A `Press ENTER or type command to continue` line in a capture means nvim is blocked on a
  message. Read it (it's often a config problem worth fixing), then `send-key enter`.
- To close a review tab cleanly: escape, `:qa!`, enter. The pane closes when nvim exits.

## Keys to tell the user

Leader and localleader are `<space>`.

| Where | Keys |
|---|---|
| diffview | `Tab`/`S-Tab` next/prev file, `]c`/`[c` next/prev hunk, `g?` help, `:DiffviewClose` |
| diffview | `:DiffviewOpen main...` branch, `:DiffviewFileHistory %` file history |
| octo review | `]q`/`[q` file, `]t`/`[t` thread, `<space>ca` comment, `<space>sa` suggestion, `<space>vs` submit, `<C-c>` close |
| octo | bare `:Octo` lists every action; `:Octo pr list`, `:Octo review start`/`resume` |
| gitsigns (any buffer) | `]c`/`[c` hunk, `<space>h…` stage/reset/preview/blame |

## Changing the setup

The nvim config is `~/dotfiles/nvim`, a git submodule of `k-chrispens/nvim-config` (on
`master`); review plugins live in `lua/custom/plugins/git.lua`. Commit and push inside the
submodule, then `git add nvim` and commit in `~/dotfiles`. Stage the submodule **before** running
`git submodule update`, or it checks out the old recorded commit over your work. Icons follow
`vim.g.have_nerd_font`; set it true only if the terminal font is a Nerd Font.
