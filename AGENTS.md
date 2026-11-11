# Agent Notes

## Releases

1. Run `npm version <patch|minor|major>` and verify `package.json` updates.
2. Update `CHANGELOG.md` for the release.
3. Commit the release changes and tag with the same version.
4. Push commits and tags, then publish with `npm publish` if needed.

## Extensions

Pi extensions live in `.pi/extensions/` (the standard auto-discovery path). When working in this repo, add or update extensions there. You can consult the `pi-mono` for reference, but do not modify code in `pi-mono`.

## Skills

Skills live in `skills/` and are shared between pi and Claude Code. `./setup.sh` symlinks them into both `~/.pi/agent/skills/` (for pi) and `~/.claude/skills/` (for Claude Code / Amp). In Claude Code each skill becomes a `/<name>` slash command. Add new skills as `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`); re-run `./setup.sh` to register them.

`vendor/janestreet-agent_skills/` is a git subtree of https://github.com/janestreet/agent_skills; its `socratic-tutor` skill is not registered on its own; `skills/learning-mode/socratic-tutor.md` is a relative symlink to it and `learning-mode` loads it. Do not edit it in place. Update with `git subtree pull --prefix=vendor/janestreet-agent_skills https://github.com/janestreet/agent_skills master --squash`, review the diff, and check that `skills/learning-mode/SKILL.md` still matches what `socratic-tutor` says. To register a new upstream skill on its own, add a relative symlink to its directory in `skills/`.
