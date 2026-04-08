#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PI_AGENT_DIR="$HOME/.pi/agent"
PI_SETTINGS="$PI_AGENT_DIR/settings.json"
CLAUDE_DIR="$HOME/.claude"

echo "=== agent-stuff setup ==="
echo "Source: $SCRIPT_DIR"
echo ""

# ---------------------------------------------------------------------------
# Helper: create a symlink, backing up any existing target
# ---------------------------------------------------------------------------
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
        mv "$dst" "$dst.bak"
        echo "  backed up  $dst -> $dst.bak"
    fi

    ln -s "$src" "$dst"
    echo "  linked     $dst -> $src"
}

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
# ~/.pi/agent/settings.json — merge extensions and remove deprecated pi-review-loop package
# ---------------------------------------------------------------------------
# Auto-discover all .ts extensions in .pi/extensions/
AGENT_STUFF_EXTENSIONS=()
shopt -s nullglob
for ext in "$SCRIPT_DIR/.pi/extensions/"*.ts; do
    AGENT_STUFF_EXTENSIONS+=("$ext")
done
shopt -u nullglob

if command -v jq &>/dev/null; then
    if [ ! -f "$PI_SETTINGS" ]; then
        echo '{}' > "$PI_SETTINGS"
    fi

    ext_json="[]"
    for ext in "${AGENT_STUFF_EXTENSIONS[@]}"; do
        ext_json=$(echo "$ext_json" | jq --arg e "$ext" '. + [$e]')
    done

    # Remove any existing extensions from this repo, then add current ones
    existing=$(jq -r '.extensions // []' "$PI_SETTINGS")
    merged=$(echo "$existing" | jq --arg repo "$SCRIPT_DIR" '[.[] | select(startswith($repo) | not)]' | jq --argjson new "$ext_json" '. + $new | unique')

    jq --argjson exts "$merged" '
        .extensions = $exts
        | .enableSkillCommands = true
        | .packages = ((.packages // []) | map(select(
            . != "npm:pi-review-loop"
            and . != "pi-review-loop"
            and ((type != "object") or ((.source // "") != "npm:pi-review-loop" and (.source // "") != "pi-review-loop"))
        )))
    ' \
        "$PI_SETTINGS" > "$PI_SETTINGS.tmp" && mv "$PI_SETTINGS.tmp" "$PI_SETTINGS"

    echo "  merged     $PI_SETTINGS ($(echo "$merged" | jq -r 'length') extensions)"
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
        link "${skill_dir%/}" "$CLAUDE_SKILLS_DIR/$skill_name"
        # Amp-specific: its loader picks up SKILL.md from *.bak directories,
        # which would shadow our symlink. Only clean up .bak when Amp is
        # installed, so Claude-only machines never silently delete a
        # user-owned skill that happened to collide with a repo skill name.
        if command -v amp &>/dev/null && [ -d "$CLAUDE_SKILLS_DIR/$skill_name.bak" ]; then
            rm -rf "$CLAUDE_SKILLS_DIR/$skill_name.bak"
            echo "  cleaned    $CLAUDE_SKILLS_DIR/$skill_name.bak"
        fi
    done
    shopt -u nullglob
    echo ""
fi

# ---------------------------------------------------------------------------
# Ensure shim scripts are executable
# ---------------------------------------------------------------------------
for dir in intercepted-commands pixi-intercepted-commands; do
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
echo "=== done ==="
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
echo "Settings extensions:"
if command -v jq &>/dev/null && [ -f "$PI_SETTINGS" ]; then
    jq -r '.extensions[]? // empty' "$PI_SETTINGS" | while read -r f; do echo "  $(basename "$f")"; done
fi
