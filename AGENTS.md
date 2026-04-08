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
