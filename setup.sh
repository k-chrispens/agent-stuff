#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PI_AGENT_DIR="$HOME/.pi/agent"
PI_SETTINGS="$PI_AGENT_DIR/settings.json"
CLAUDE_DIR="$HOME/.claude"
ZMX_PACKAGE="npm:@deevus/pi-zmx"

echo "=== agent-stuff setup ==="
echo "Source: $SCRIPT_DIR"
echo ""

# ---------------------------------------------------------------------------
# Helpers: keep backups outside all skill/extension discovery directories
# ---------------------------------------------------------------------------
backup() {
    local dst="$1" backup_dir
    mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/agent-stuff/backups"
    backup_dir="$(mktemp -d "${XDG_STATE_HOME:-$HOME/.local/state}/agent-stuff/backups/$(basename "$dst").XXXXXX")"
    mv "$dst" "$backup_dir/"
    echo "  backed up  $dst -> $backup_dir/"
}

link() {
    local src="$1" dst="$2"

    if [ -L "$dst" ]; then
        local current
        current="$(readlink "$dst")"
        if [ "$current" = "$src" ]; then
            echo "  ok         $dst -> $src"
            return
        fi
        rm "$dst"
        echo "  relinked   $dst -> $src (was $current)"
    elif [ -e "$dst" ]; then
        backup "$dst"
    fi

    ln -s "$src" "$dst"
    echo "  linked     $dst -> $src"
}

# ---------------------------------------------------------------------------
# Sync blueprint skills from k-chrispens/blueprint fork
#
# The skill content lives in a separate repo (a personal fork of imbue-ai/blueprint).
# We clone it into $SCRIPT_DIR/.cache/blueprint (gitignored) and then symlink
# skills/blueprint{,-generate} into the cache. The existing per-skill loops below
# then pick them up automatically — no special-casing in the install logic.
#
# Update policy: try `git fetch && git merge --ff-only`, but tolerate offline
# or non-ff state by falling back to the cached copy with a warning.
# ---------------------------------------------------------------------------
BLUEPRINT_FORK_URL="git@github.com:k-chrispens/blueprint.git"
BLUEPRINT_BRANCH="main"
BLUEPRINT_CACHE_DIR="$SCRIPT_DIR/.cache/blueprint"
BLUEPRINT_SKILLS=(blueprint blueprint-generate)
BLUEPRINT_OK=0

if command -v git &>/dev/null; then
    if [ ! -d "$BLUEPRINT_CACHE_DIR/.git" ]; then
        mkdir -p "$(dirname "$BLUEPRINT_CACHE_DIR")"
        echo "  cloning    $BLUEPRINT_FORK_URL -> $BLUEPRINT_CACHE_DIR"
        if git clone --quiet --branch "$BLUEPRINT_BRANCH" "$BLUEPRINT_FORK_URL" "$BLUEPRINT_CACHE_DIR"; then
            BLUEPRINT_OK=1
        else
            echo "  WARNING    failed to clone blueprint fork — blueprint skills will be skipped"
        fi
    else
        if git -C "$BLUEPRINT_CACHE_DIR" fetch --quiet origin "$BLUEPRINT_BRANCH" 2>/dev/null \
            && git -C "$BLUEPRINT_CACHE_DIR" merge --ff-only --quiet "origin/$BLUEPRINT_BRANCH" 2>/dev/null; then
            sha=$(git -C "$BLUEPRINT_CACHE_DIR" rev-parse --short HEAD)
            echo "  updated    $BLUEPRINT_CACHE_DIR @ $sha"
        else
            sha=$(git -C "$BLUEPRINT_CACHE_DIR" rev-parse --short HEAD 2>/dev/null || echo "?")
            echo "  WARNING    blueprint fork not updated (offline or non-ff) — using cached @ $sha"
        fi
        BLUEPRINT_OK=1
    fi

    if [ "$BLUEPRINT_OK" = "1" ]; then
        for skill_name in "${BLUEPRINT_SKILLS[@]}"; do
            src="$BLUEPRINT_CACHE_DIR/skills/$skill_name"
            dst="$SCRIPT_DIR/skills/$skill_name"
            if [ ! -d "$src" ]; then
                echo "  WARNING    $src missing in fork — $skill_name not installed"
                continue
            fi
            link "$src" "$dst"
        done
    fi
else
    echo "  WARNING    git not found — skipping blueprint fork sync"
fi

# ---------------------------------------------------------------------------
# Symlink external skills into repo (gitignored, source of truth elsewhere)
# ---------------------------------------------------------------------------
EXTERNAL_SKILLS=("$HOME/.claude/skills/actl")
for ext_skill in "${EXTERNAL_SKILLS[@]}"; do
    [ -d "$ext_skill" ] || continue
    skill_name="$(basename "$ext_skill")"
    link "$ext_skill" "$SCRIPT_DIR/skills/$skill_name"
done

# ---------------------------------------------------------------------------
# ~/.pi/agent/extensions -> repo global/extensions
# ---------------------------------------------------------------------------
mkdir -p "$PI_AGENT_DIR"
link "$SCRIPT_DIR/global/extensions" "$PI_AGENT_DIR/extensions"

# ---------------------------------------------------------------------------
# ~/.pi/agent/skills -> repo skills
# ---------------------------------------------------------------------------
link "$SCRIPT_DIR/skills" "$PI_AGENT_DIR/skills"

# ---------------------------------------------------------------------------
# ~/.pi/agent/settings.json — use repo extensions, including directory entry points
# ---------------------------------------------------------------------------
# Shared Ponytail skills already come from the Claude marketplace symlinks.
SHARED_PONYTAIL=true
for name in ponytail ponytail-audit ponytail-debt ponytail-gain ponytail-help ponytail-review; do
    if [ ! -f "$HOME/.agents/skills/$name/SKILL.md" ]; then
        SHARED_PONYTAIL=false
    fi
done

if command -v jq &>/dev/null; then
    if [ ! -f "$PI_SETTINGS" ]; then
        echo '{}' > "$PI_SETTINGS"
    fi

    # Replace old per-file entries, preserving extensions outside this repo.
    merged=$(jq --arg repo "$SCRIPT_DIR/" --arg ext "$SCRIPT_DIR/.pi/extensions" \
        '[(.extensions // [])[] | select(startswith($repo) | not)] + [$ext] | unique' "$PI_SETTINGS")

    jq --argjson exts "$merged" --arg zmx "$ZMX_PACKAGE" --argjson shared_ponytail "$SHARED_PONYTAIL" '
        .extensions = $exts
        | .enableSkillCommands = true
        | .packages = (
            (.packages // []) | map(select(
                . != "npm:pi-review-loop"
                and . != "pi-review-loop"
                and ((type != "object") or ((.source // "") != "npm:pi-review-loop" and (.source // "") != "pi-review-loop"))
            )) | map(
                if $shared_ponytail and ((if type == "string" then . else .source end) == "git:github.com/DietrichGebert/ponytail") then
                    (if type == "string" then {source: .} else . end) | .skills = []
                else . end
            )
            | if any((type == "string" and . == $zmx) or (type == "object" and .source == $zmx)) then . else . + [$zmx] end
        )
    ' \
        "$PI_SETTINGS" > "$PI_SETTINGS.tmp"
    mv "$PI_SETTINGS.tmp" "$PI_SETTINGS"

    echo "  merged     $PI_SETTINGS ($(echo "$merged" | jq -r 'length') extension paths, $ZMX_PACKAGE package)"
else
    echo "  WARNING    jq not found, skipping settings.json merge"
    echo "             install jq or manually add extensions to $PI_SETTINGS"
fi

# ---------------------------------------------------------------------------
# Install npm dependencies for project-local extensions
# ---------------------------------------------------------------------------
if [ -f "$SCRIPT_DIR/.pi/extensions/package.json" ]; then
    echo "  npm install .pi/extensions/"
    (cd "$SCRIPT_DIR/.pi/extensions" && npm install --silent)
fi

# Install npm dependencies for subdirectory extensions with their own package.json
for subpkg in "$SCRIPT_DIR/.pi/extensions/"*/package.json; do
    [ -f "$subpkg" ] || continue
    dir="$(dirname "$subpkg")"
    echo "  npm install .pi/extensions/$(basename "$dir")/"
    (cd "$dir" && npm install --silent)
done

echo ""

# ---------------------------------------------------------------------------
# Claude Code / Amp: ~/.claude/CLAUDE.md -> repo global/CLAUDE.md
# ---------------------------------------------------------------------------
if command -v claude &>/dev/null || command -v amp &>/dev/null || [ -d "$CLAUDE_DIR" ]; then
    mkdir -p "$CLAUDE_DIR"
    link "$SCRIPT_DIR/global/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
    echo ""
fi

# ---------------------------------------------------------------------------
# Claude Code / Amp: ~/.claude/skills/<name> -> repo skills/<name> (per skill)
#
# Both Claude Code and Amp discover skills by scanning ~/.claude/skills/ for
# SKILL.md files. In Claude Code each becomes a /<name> slash command.
#
# link() only touches names that match directories under ./skills/, so any
# unrelated skill in ~/.claude/skills/ (e.g. claudeception) is left alone.
# ---------------------------------------------------------------------------
if command -v claude &>/dev/null || command -v amp &>/dev/null || [ -d "$CLAUDE_DIR" ]; then
    CLAUDE_SKILLS_DIR="$CLAUDE_DIR/skills"
    mkdir -p "$CLAUDE_SKILLS_DIR"
    shopt -s nullglob
    for skill_dir in "$SCRIPT_DIR/skills/"*/; do
        [ -f "$skill_dir/SKILL.md" ] || continue
        skill_name="$(basename "$skill_dir")"
        # Skip skills that are already symlinked FROM ~/.claude/skills (external skills)
        if [ -L "${skill_dir%/}" ] && readlink "${skill_dir%/}" | grep -q "^$HOME/.claude/skills/"; then
            echo "  skip       $skill_name (external, already in ~/.claude/skills)"
            continue
        fi
        link "${skill_dir%/}" "$CLAUDE_SKILLS_DIR/$skill_name"
        if [ -e "$CLAUDE_SKILLS_DIR/$skill_name.bak" ] || [ -L "$CLAUDE_SKILLS_DIR/$skill_name.bak" ]; then
            backup "$CLAUDE_SKILLS_DIR/$skill_name.bak"
        fi
    done
    shopt -u nullglob
    for stale in "$CLAUDE_SKILLS_DIR/tmux" "$CLAUDE_SKILLS_DIR/tmux.bak"; do
        if [ -L "$stale" ] && readlink "$stale" | grep -q "$SCRIPT_DIR/skills/tmux"; then
            rm "$stale"
            echo "  removed    $stale"
        fi
    done
    echo ""
fi

# ---------------------------------------------------------------------------
# Shared Agent Skills (Pi, Zed, etc.): ~/.agents/skills/<name> -> repo skills/<name>
# ---------------------------------------------------------------------------
ZED_SKILLS_DIR="$HOME/.agents/skills"
mkdir -p "$ZED_SKILLS_DIR"
shopt -s nullglob
for skill_dir in "$SCRIPT_DIR/skills/"*/; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name="$(basename "$skill_dir")"
    link "${skill_dir%/}" "$ZED_SKILLS_DIR/$skill_name"
    if [ -e "$ZED_SKILLS_DIR/$skill_name.bak" ] || [ -L "$ZED_SKILLS_DIR/$skill_name.bak" ]; then
        backup "$ZED_SKILLS_DIR/$skill_name.bak"
    fi
done
shopt -u nullglob
echo ""

# ---------------------------------------------------------------------------
# Ensure shim scripts are executable
# ---------------------------------------------------------------------------
for dir in intercepted-commands pixi-intercepted-commands .pi/intercepted-commands .pi/pixi-intercepted-commands; do
    target="$SCRIPT_DIR/$dir"
    if [ -d "$target" ]; then
        shopt -s nullglob
        files=("$target"/*)
        shopt -u nullglob
        if (( ${#files[@]} )); then
            chmod +x "${files[@]}"
            echo "  chmod +x   $target/*"
        fi
    fi
done

echo ""
echo "Symlinks:"
for p in "$PI_AGENT_DIR/extensions" "$PI_AGENT_DIR/skills" "$CLAUDE_DIR/CLAUDE.md"; do
    if [ -L "$p" ]; then
        echo "  $p -> $(readlink "$p")"
    fi
done
if [ -d "$CLAUDE_DIR/skills" ]; then
    for p in "$CLAUDE_DIR/skills/"*/; do
        [ -L "${p%/}" ] || continue
        echo "  ${p%/} -> $(readlink "${p%/}")"
    done
fi
echo ""
echo "Global extensions (auto-discovered):"
for f in "$PI_AGENT_DIR/extensions/"*.ts; do
    [ -e "$f" ] || continue
    echo "  $(basename "$f")"
done
echo ""
echo "Skills (pi):"
for f in "$PI_AGENT_DIR/skills/"*/; do
    [ -d "$f" ] || continue
    echo "  $(basename "$f")"
done
echo ""
echo "Skills (Claude Code / Amp):"
for f in "$CLAUDE_DIR/skills/"*/; do
    [ -L "${f%/}" ] && [ -f "$f/SKILL.md" ] || continue
    echo "  $(basename "$f")"
done
echo ""
echo "Skills (Zed Agent):"
for f in "$ZED_SKILLS_DIR/"*/; do
    [ -L "${f%/}" ] && [ -f "$f/SKILL.md" ] || continue
    echo "  $(basename "$f")"
done
echo ""
echo "Settings extensions:"
if command -v jq &>/dev/null && [ -f "$PI_SETTINGS" ]; then
    jq -r '.extensions[]? // empty' "$PI_SETTINGS" | while read -r f; do echo "  $(basename "${f#[-+]}")"; done
    echo ""
    echo "Settings packages:"
    jq -r '.packages[]? | if type == "string" then . else .source end' "$PI_SETTINGS" | while read -r p; do echo "  $p"; done
fi
